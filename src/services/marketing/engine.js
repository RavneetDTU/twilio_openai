// In-process campaign runner. State lives in the marketing store, so a restart
// continues from Firestore instead of from memory. There is no Redis in this
// project; a new queue package would be an extra service to run. node-cron is
// only a timer — the worker uses setInterval the same way.

import { contactEligible } from './audience.js';
import { conversationDocId, recipientDocId } from './phone.js';
import { campaignIsSendable, fillTemplate, variableIndexes } from './templates.js';

const TEMPORARY_CODES = new Set([1, 2, 4, 80007, 130429, 131000, 131056, 133004]);

export function classifySendError(result) {
    if (!result || result.ok) return 'ok';
    const message = String(result.error || '');
    if (/not configured|WA_TOKEN|WA_PHONE_ID/i.test(message)) return 'permanent';
    if (/ECONN|ETIMEDOUT|timeout|network|socket/i.test(message)) return 'temporary';
    if (!result.status || result.status >= 500 || result.status === 429) return 'temporary';
    if (result.code != null && TEMPORARY_CODES.has(Number(result.code))) return 'temporary';
    return 'permanent';
}

export function backoffMs(attempt) {
    return Math.min(30 * 60 * 1000, 15000 * (2 ** Math.max(0, attempt - 1)));
}

const RANK = { pending: 0, sending: 0, sent: 1, failed: 1, delivered: 2, read: 3, replied: 4 };

export function mergeDeliveryStatus(current, incoming) {
    if (!incoming) return current || 'pending';
    if (incoming === 'failed') {
        if (current === 'delivered' || current === 'read' || current === 'replied') return current;
        return 'failed';
    }
    if (current === 'failed' && incoming !== 'replied') return 'failed';
    if ((RANK[incoming] ?? -1) >= (RANK[current] ?? -1)) return incoming;
    return current || incoming;
}

export function metricsFromBuckets(byStatus) {
    const sent = byStatus.sent + byStatus.delivered + byStatus.read + byStatus.replied;
    const delivered = byStatus.delivered + byStatus.read + byStatus.replied;
    const read = byStatus.read + byStatus.replied;
    const replied = byStatus.replied;
    const failed = byStatus.failed;
    const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
    return {
        total,
        byStatus,
        pending: byStatus.pending,
        sending: byStatus.sending,
        queued: byStatus.pending + byStatus.sending,
        sent,
        delivered,
        read,
        replied,
        failed,
        cancelled: byStatus.cancelled,
        skipped: byStatus.skipped,
        remaining: byStatus.pending + byStatus.sending,
        deliveryRate: sent ? delivered / sent : 0,
        readRate: delivered ? read / delivered : 0,
        replyRate: delivered ? replied / delivered : 0,
        failRate: (sent + failed) ? failed / (sent + failed) : 0,
    };
}

const EMPTY_BUCKETS = () => ({
    pending: 0, sending: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, cancelled: 0, skipped: 0,
});

export function recount(recipients) {
    const byStatus = EMPTY_BUCKETS();
    for (const row of recipients) {
        const status = byStatus[row.status] == null ? 'pending' : row.status;
        byStatus[status] += 1;
    }
    return metricsFromBuckets(byStatus);
}

export function shiftMetric(metrics, from, to) {
    const byStatus = { ...EMPTY_BUCKETS(), ...(metrics?.byStatus || {}) };
    if (from) byStatus[from] = Math.max(0, (byStatus[from] || 0) - 1);
    if (to) byStatus[to] = (byStatus[to] || 0) + 1;
    return metricsFromBuckets(byStatus);
}

function paramValue(source, custom, contact, restaurantName) {
    if (source === 'contact.name') return contact.name || 'there';
    if (source === 'restaurant.name') return restaurantName || '';
    return custom == null ? '' : String(custom);
}

export function bodyParameters(template, mapping, contact, restaurantName) {
    const needed = variableIndexes(template?.body || '');
    const byIndex = new Map((mapping || []).map((item) => [Number(item.index), item]));
    const values = [];
    for (const index of needed) {
        const item = byIndex.get(index);
        const value = paramValue(item?.source, item?.value, contact, restaurantName);
        if (!value) return { ok: false, reason: 'missing_variables' };
        values.push(value);
    }
    return { ok: true, values };
}

export function templateComponents(template, values) {
    const components = [];
    if (template?.header && String(template.header.format || 'TEXT').toUpperCase() !== 'TEXT') {
        const format = String(template.header.format).toLowerCase();
        const link = template.header.exampleUrl;
        if (!link) return { ok: false, reason: 'missing_header_media' };
        components.push({
            type: 'header',
            parameters: [{ type: format, [format]: { link } }],
        });
    }
    if (values.length) {
        components.push({
            type: 'body',
            parameters: values.map((text) => ({ type: 'text', text })),
        });
    }
    return { ok: true, components, preview: fillTemplate(template.body, values) };
}

async function saveCampaignMetrics(store, campaignId, metrics, now) {
    const campaign = await store.get('campaigns', campaignId);
    if (!campaign) return null;
    const done = metrics.remaining === 0 && metrics.sending === 0 && !['paused', 'cancelled', 'draft', 'scheduled'].includes(campaign.status);
    const status = campaign.status === 'cancelled' || campaign.status === 'paused'
        ? campaign.status
        : (done ? 'completed' : campaign.status);
    const next = { ...campaign, metrics, status, updatedAt: now.toISOString() };
    if (status === 'completed') next.finishedAt = campaign.finishedAt || next.updatedAt;
    await store.put('campaigns', campaignId, next);
    return next;
}

async function refreshMetrics(store, campaignId) {
    const recipients = await store.list('recipients', [{ field: 'campaignId', op: '==', value: campaignId }]);
    const campaign = await store.get('campaigns', campaignId);
    if (!campaign) return null;
    return saveCampaignMetrics(store, campaignId, recount(recipients), new Date());
}

export async function recoverStuckRecipients(store, now, staleMs = 120000) {
    const sending = await store.query('recipients', {
        filters: [{ field: 'status', op: '==', value: 'sending' }],
        limit: 100,
    });
    let recovered = 0;
    for (const row of sending) {
        if (row.wamid) continue;
        const lease = Date.parse(row.leaseExpiresAt || row.claimedAt || 0);
        if (Number.isNaN(lease) || now.getTime() - lease < staleMs) continue;
        const campaign = row.campaignId ? await store.get('campaigns', row.campaignId) : null;
        const bucket = campaign?.metrics?.sending > 0 ? campaign.metrics : null;
        if (row.dispatchStartedAt) {
            await store.put('recipients', row.id, {
                ...row,
                status: 'failed',
                reason: 'uncertain_delivery',
                lastError: 'uncertain_delivery',
                claimedAt: null,
                updatedAt: now.toISOString(),
            });
            if (bucket) await saveCampaignMetrics(store, campaign.id, shiftMetric(bucket, 'sending', 'failed'), now);
            continue;
        }
        await store.put('recipients', row.id, {
            ...row,
            status: 'pending',
            claimedAt: null,
            leaseExpiresAt: null,
            updatedAt: now.toISOString(),
        });
        if (bucket) await saveCampaignMetrics(store, campaign.id, shiftMetric(bucket, 'sending', 'pending'), now);
        recovered += 1;
    }
    return recovered;
}

async function skip(store, row, reason, now) {
    await store.put('recipients', row.id, {
        ...row,
        status: 'skipped',
        reason,
        updatedAt: now.toISOString(),
    });
}

/**
 * Send at most `batchSize` pending recipients for one campaign.
 * Each recipient id is campaign+phone, and a row that already has a wamid
 * is never sent again.
 */
export async function progressCampaign({ store, sender, now, campaign, limits, restaurantName }) {
    const current = await store.get('campaigns', campaign.id);
    if (!current) return null;
    if (current.status === 'scheduled') {
        if (Date.parse(current.sendAt) > now.getTime()) return current;
        current.status = 'running';
        current.startedAt = current.startedAt || now.toISOString();
        await store.put('campaigns', current.id, { ...current, updatedAt: now.toISOString() });
    }
    if (current.status === 'queued') {
        current.status = 'running';
        current.startedAt = current.startedAt || now.toISOString();
        await store.put('campaigns', current.id, current);
    }
    if (current.status !== 'running') return current;

    const template = await store.get('templates', current.templateId);
    if (!campaignIsSendable(template) || template.restaurantId !== current.restaurantId) {
        await store.put('campaigns', current.id, {
            ...current,
            status: 'failed',
            failureReason: 'template_not_approved',
            updatedAt: now.toISOString(),
        });
        return store.get('campaigns', current.id);
    }

    let metrics = current.metrics?.byStatus ? current.metrics : null;
    if (!metrics) {
        const seeded = await refreshMetrics(store, current.id);
        if (!seeded) return null;
        if (seeded.status !== 'running') return seeded;
        metrics = seeded.metrics;
    }

    const batch = (await store.query('recipients', {
        filters: [
            { field: 'campaignId', op: '==', value: current.id },
            { field: 'status', op: '==', value: 'pending' },
        ],
        orderBy: { field: 'createdAt', direction: 'asc' },
        limit: limits.batchSize,
    })).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)));

    const due = [];
    let earliestRetry = null;
    for (const row of batch) {
        const retryAt = row.nextAttemptAt ? Date.parse(row.nextAttemptAt) : 0;
        if (!row.nextAttemptAt || retryAt <= now.getTime()) due.push(row);
        else if (earliestRetry == null || retryAt < earliestRetry) earliestRetry = retryAt;
    }
    let nextDelayMs = earliestRetry == null ? null : Math.max(0, earliestRetry - now.getTime());

    const move = (from, to) => {
        if (metrics) metrics = shiftMetric(metrics, from, to);
    };

    for (const row of due) {
        if (limits.intervalMs > 0 && limits.nextSlot && Date.now() < limits.nextSlot) {
            await new Promise((resolve) => setTimeout(resolve, limits.nextSlot - Date.now()));
        }
        if (limits.nextSlot && !limits.intervalMs && now.getTime() < limits.nextSlot) {
            nextDelayMs = Math.max(0, limits.nextSlot - now.getTime());
            break;
        }
        const freshCampaign = await store.get('campaigns', current.id);
        if (!freshCampaign || freshCampaign.status === 'paused' || freshCampaign.status === 'cancelled') break;

        const claimed = await store.updateIf(
            'recipients',
            row.id,
            (doc) => doc.status === 'pending' && !doc.wamid,
            {
                status: 'sending',
                claimedAt: now.toISOString(),
                sendingStartedAt: now.toISOString(),
                leaseExpiresAt: new Date(now.getTime() + 120000).toISOString(),
            },
        );
        if (!claimed) continue;
        move('pending', 'sending');

        const contact = await store.get('contacts', claimed.contactId);
        const suppression = await store.get('suppressions', `${current.restaurantId}_${claimed.phoneDigits}`);
        const decision = contactEligible(contact, suppression);
        if (!decision.ok) {
            await skip(store, claimed, decision.reason, now);
            move('sending', 'skipped');
            continue;
        }

        const params = bodyParameters(template, current.variableMapping, contact, restaurantName || current.restaurantName);
        if (!params.ok) {
            await store.put('recipients', claimed.id, { ...claimed, status: 'failed', reason: params.reason, lastError: params.reason, wamid: null });
            move('sending', 'failed');
            continue;
        }
        const built = templateComponents(template, params.values);
        if (!built.ok) {
            await store.put('recipients', claimed.id, { ...claimed, status: 'failed', reason: built.reason, lastError: built.reason, wamid: null });
            move('sending', 'failed');
            continue;
        }

        const dispatching = { ...claimed, dispatchStartedAt: now.toISOString() };
        await store.put('recipients', claimed.id, dispatching);
        let result;
        try {
            result = await sender({
                to: contact.phoneE164,
                name: template.metaName || template.name,
                languageCode: template.language || 'en',
                components: built.components,
            });
        } catch {
            result = { ok: false, error: 'send_threw', uncertain: true };
        }
        if (limits.noteSend) limits.noteSend(now.getTime());

        if (result?.ok && result.messageId) {
            const sentAt = now.toISOString();
            await store.put('recipients', claimed.id, {
                ...claimed,
                status: 'sent',
                wamid: result.messageId,
                reason: null,
                attempts: (claimed.attempts || 0) + 1,
                sentAt,
                updatedAt: sentAt,
                preview: built.preview,
                dispatchStartedAt: dispatching.dispatchStartedAt,
            });
            move('sending', 'sent');
            const conversationId = conversationDocId(current.restaurantId, contact.phoneDigits);
            await store.put('messages', result.messageId, {
                id: result.messageId,
                restaurantId: current.restaurantId,
                campaignId: current.id,
                contactId: contact.id,
                conversationId,
                phoneDigits: contact.phoneDigits,
                direction: 'outbound',
                kind: 'template',
                templateName: template.name,
                body: built.preview,
                status: 'sent',
                wamid: result.messageId,
                createdAt: sentAt,
            });
            const prior = await store.get('conversations', conversationId);
            const keepHandler = prior && ['human', 'resolved', 'booking'].includes(prior.handler);
            await store.put('conversations', conversationId, {
                id: conversationId,
                restaurantId: current.restaurantId,
                contactId: contact.id,
                phoneDigits: contact.phoneDigits,
                name: contact.name || prior?.name || 'Guest',
                handler: keepHandler ? prior.handler : (prior?.handler || 'ai'),
                campaignId: current.id,
                lastCustomerMessageAt: prior?.lastCustomerMessageAt || null,
                lastMessage: built.preview,
                lastMessageKind: 'template',
                templateName: template.name,
                unread: prior?.unread || 0,
                createdAt: prior?.createdAt || sentAt,
                updatedAt: sentAt,
                assignedTo: prior?.assignedTo || null,
            });
        } else if (result?.uncertain) {
            await store.put('recipients', claimed.id, {
                ...dispatching,
                status: 'failed',
                reason: 'uncertain_delivery',
                lastError: 'uncertain_delivery',
                claimedAt: null,
                updatedAt: now.toISOString(),
            });
            move('sending', 'failed');
        } else {
            const kind = classifySendError(result);
            const attempts = (claimed.attempts || 0) + 1;
            const giveUp = kind === 'permanent' || attempts >= limits.maxAttempts;
            const nextAttemptAt = giveUp ? null : new Date(now.getTime() + backoffMs(attempts)).toISOString();
            await store.put('recipients', claimed.id, {
                ...claimed,
                status: giveUp ? 'failed' : 'pending',
                reason: result?.error || kind,
                lastError: result?.error || kind,
                errorCode: result?.code ?? null,
                attempts,
                nextAttemptAt,
                claimedAt: null,
                dispatchStartedAt: null,
                leaseExpiresAt: null,
                updatedAt: now.toISOString(),
            });
            move('sending', giveUp ? 'failed' : 'pending');
            if (!giveUp) {
                const wait = Date.parse(nextAttemptAt) - now.getTime();
                if (nextDelayMs == null || wait < nextDelayMs) nextDelayMs = Math.max(0, wait);
            }
        }
    }

    if (!due.length && !batch.length && metrics && metrics.pending > 0) {
        return refreshMetrics(store, current.id);
    }
    const saved = metrics ? await saveCampaignMetrics(store, current.id, metrics, now) : await refreshMetrics(store, current.id);
    if (saved && ['running', 'queued', 'scheduled'].includes(saved.status) && nextDelayMs == null && (saved.metrics?.pending || 0) > 0) {
        nextDelayMs = Math.max(limits.intervalMs || 0, 250);
    }
    if (saved) saved.nextDelayMs = nextDelayMs;
    return saved;
}

export async function applyDeliveryUpdate(store, status) {
    const wamid = status?.id;
    if (!wamid) return { duplicate: false, applied: false };
    const eventId = `${wamid}:${status.status}:${status.timestamp || ''}`;
    const existing = await store.get('events', eventId);
    const message = await store.get('messages', wamid);
    if (!message) return { duplicate: false, applied: false };
    if (existing) return { duplicate: true, applied: false };
    await store.put('events', eventId, {
        id: eventId,
        kind: 'message_status',
        wamid,
        status: status.status,
        timestamp: status.timestamp || null,
        errorCode: status.errors?.[0]?.code ?? null,
        restaurantId: message.restaurantId,
        createdAt: new Date().toISOString(),
    });
    const incoming = String(status.status || '').toLowerCase();
    const merged = mergeDeliveryStatus(message.status, incoming);
    if (merged !== message.status) {
        await store.put('messages', wamid, { ...message, status: merged, errorCode: status.errors?.[0]?.code ?? message.errorCode ?? null });
    }
    const recipientId = recipientDocId(message.campaignId, message.phoneDigits);
    const recipient = message.campaignId ? await store.get('recipients', recipientId) : null;
    if (recipient) {
        const recipientStatus = mergeDeliveryStatus(recipient.status, incoming);
        if (recipientStatus !== recipient.status) {
            await store.put('recipients', recipient.id, {
                ...recipient,
                status: recipientStatus,
                errorCode: status.errors?.[0]?.code ?? recipient.errorCode ?? null,
                updatedAt: new Date().toISOString(),
            });
            const campaign = await store.get('campaigns', recipient.campaignId);
            if (campaign?.metrics?.byStatus) {
                await saveCampaignMetrics(store, campaign.id, shiftMetric(campaign.metrics, recipient.status, recipientStatus), new Date());
            } else {
                await refreshMetrics(store, recipient.campaignId);
            }
        }
    }
    return { duplicate: false, applied: true, status: merged };
}

export { recipientDocId };
