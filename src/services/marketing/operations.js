// Dashboard operations for one restaurant. Every read and write is scoped by
// restaurantId. A booking in the guest book is not marketing consent.

import { randomUUID } from 'crypto';
import { splitAudience } from './audience.js';
import { parseCsv, mapRow } from './csv.js';
import { applyDeliveryUpdate, bodyParameters, progressCampaign, recount, recoverStuckRecipients, shiftMetric } from './engine.js';
import {
    contactDocId,
    conversationDocId,
    isExplicitOptIn,
    normalizePhone,
    recipientDocId,
    suppressionDocId,
} from './phone.js';
import {
    campaignIsSendable,
    mapMetaTemplateStatus,
    toMetaCreatePayload,
    validateTemplateDraft,
} from './templates.js';

export class MarketingError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const WINDOW_MS = 24 * 60 * 60 * 1000;

export function customerWindowOpen(conversation, now = Date.now()) {
    const last = Date.parse(conversation?.lastCustomerMessageAt || '');
    return !Number.isNaN(last) && now - last < WINDOW_MS;
}

function nowIso() {
    return new Date().toISOString();
}

async function audit(store, restaurantId, action, details = {}) {
    const id = randomUUID();
    await store.put('audit', id, { id, restaurantId, action, details, at: nowIso() });
}

async function settingsOf(store, restaurantId) {
    return (await store.get('settings', restaurantId)) || {
        restaurantId,
        offers: [],
        events: [],
        menuUrl: '',
        defaultCountryCode: '27',
    };
}

function publicContact(contact) {
    return contact;
}

export async function getOverview(store, restaurantId) {
    const restaurant = { field: 'restaurantId', op: '==', value: restaurantId };
    const [totalContacts, optedInContacts, campaigns, aiConversations, recent, humans] = await Promise.all([
        store.count('contacts', [restaurant]),
        store.count('contacts', [restaurant, { field: 'optIn', op: '==', value: true }]),
        store.list('campaigns', [restaurant]),
        store.count('conversations', [restaurant, { field: 'handler', op: '==', value: 'ai' }]),
        store.query('conversations', {
            filters: [restaurant],
            orderBy: { field: 'updatedAt', direction: 'desc' },
            limit: 6,
        }),
        store.query('conversations', {
            filters: [restaurant, { field: 'handler', op: '==', value: 'human' }],
            limit: 50,
        }),
    ]);
    const metrics = campaigns.reduce((sum, campaign) => {
        const row = campaign.metrics || {};
        sum.sent += row.sent || 0;
        sum.delivered += row.delivered || 0;
        sum.read += row.read || 0;
        sum.replied += row.replied || 0;
        sum.failed += row.failed || 0;
        return sum;
    }, { sent: 0, delivered: 0, read: 0, replied: 0, failed: 0 });
    const active = campaigns.filter((item) => ['scheduled', 'queued', 'running', 'paused'].includes(item.status)).length;
    const handoffs = campaigns.reduce((sum, campaign) => sum + (campaign.metrics?.bookingHandoffs || 0), 0);
    return {
        totalContacts,
        optedInContacts,
        totalCampaigns: campaigns.length,
        activeCampaigns: active,
        messagesSent: metrics.sent,
        messagesDelivered: metrics.delivered,
        messagesRead: metrics.read,
        repliesReceived: metrics.replied,
        failedMessages: metrics.failed,
        aiConversations,
        needsHuman: humans.filter((item) => (item.unread || 0) > 0).length,
        conversionRate: metrics.delivered ? handoffs / metrics.delivered : 0,
        bookingHandoffs: handoffs,
        recent: recent.map((item) => ({
            id: item.id,
            name: item.name,
            phoneDigits: item.phoneDigits,
            lastMessage: item.lastMessage || '',
            lastMessageKind: item.lastMessageKind || '',
            handler: item.handler,
            campaignId: item.campaignId || null,
            updatedAt: item.updatedAt || null,
        })),
    };
}

function filterContacts(all, query = {}) {
    const needle = String(query.q || '').trim().toLowerCase();
    const tag = String(query.tag || '').trim();
    const optIn = query.optIn;
    return all.filter((contact) => {
        if (tag && !(contact.tags || []).includes(tag)) return false;
        if (optIn === 'true' && !contact.optIn) return false;
        if (optIn === 'false' && contact.optIn) return false;
        if (!needle) return true;
        return [contact.name, contact.phoneE164, contact.email]
            .some((value) => String(value || '').toLowerCase().includes(needle));
    }).sort((a, b) => String(a.nameLower || '').localeCompare(String(b.nameLower || '')));
}

export async function listContacts(store, restaurantId, query = {}) {
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
    const offset = Math.max(0, Number(query.offset) || 0);
    const restaurant = { field: 'restaurantId', op: '==', value: restaurantId };
    if (!query.q && !query.tag && query.optIn == null) {
        const total = await store.count('contacts', [restaurant]);
        if (total > 500) {
            const page = await store.query('contacts', {
                filters: [restaurant],
                orderBy: { field: 'nameLower', direction: 'asc' },
                limit,
                offset,
            });
            const tags = [...new Set(page.flatMap((contact) => contact.tags || []))].sort();
            return { contacts: page.map(publicContact), total, offset, limit, tags };
        }
    }
    const all = await store.list('contacts', [restaurant]);
    const filtered = filterContacts(all, query);
    const tags = [...new Set(all.flatMap((contact) => contact.tags || []))].sort().slice(0, 200);
    return {
        contacts: filtered.slice(offset, offset + limit).map(publicContact),
        total: filtered.length,
        offset,
        limit,
        tags,
    };
}

export async function assignContactGroup(store, restaurantId, { contactIds, tag, allMatching, q, optIn } = {}) {
    const label = String(tag || '').trim();
    if (!label || label.length > 40) throw new MarketingError(400, 'tag', 'Enter a list name of 1–40 characters.');
    const all = await store.list('contacts', [{ field: 'restaurantId', op: '==', value: restaurantId }]);
    const wanted = new Set((contactIds || []).map((id) => String(id)));
    const targets = allMatching
        ? filterContacts(all, { q, optIn })
        : all.filter((contact) => wanted.has(contact.id));
    if (!targets.length) throw new MarketingError(400, 'empty', 'No contacts matched that selection.');
    if (targets.length > 10000) throw new MarketingError(400, 'too_many', 'Select at most 10,000 contacts at a time.');
    const stamp = nowIso();
    for (const contact of targets) {
        const tags = [...new Set([...(contact.tags || []), label])];
        await store.put('contacts', contact.id, { ...contact, tags, updatedAt: stamp });
    }
    await audit(store, restaurantId, 'contacts.group', { tag: label, updated: targets.length });
    return { updated: targets.length, tag: label };
}

export async function saveContact(store, restaurantId, input, contactId = null) {
    const settings = await settingsOf(store, restaurantId);
    const phone = normalizePhone(input.phone || input.phoneE164, settings.defaultCountryCode || '27');
    if (!phone.ok) throw new MarketingError(400, 'invalid_phone', 'Enter a valid phone number with a country code.');
    const id = contactId || contactDocId(restaurantId, phone.digits);
    const existing = await store.get('contacts', id);
    if (existing && existing.restaurantId !== restaurantId) {
        throw new MarketingError(404, 'not_found', 'Contact not found.');
    }
    if (!existing && contactId) throw new MarketingError(404, 'not_found', 'Contact not found.');
    const duplicate = await store.get('contacts', contactDocId(restaurantId, phone.digits));
    if (duplicate && duplicate.id !== id) throw new MarketingError(409, 'duplicate', 'That phone number is already a contact.');
    const suppression = await store.get('suppressions', suppressionDocId(restaurantId, phone.digits));
    if (input.optIn && suppression && !suppression.liftedAt) {
        throw new MarketingError(409, 'suppressed', 'This number is on the suppression list. Marketing opt-in is blocked.');
    }
    if (input.optIn && !input.optInSource && !existing?.optInSource) {
        throw new MarketingError(400, 'missing_opt_in_source', 'Marketing opt-in needs a source, such as a form or checkbox.');
    }
    const now = nowIso();
    const next = {
        id: contactDocId(restaurantId, phone.digits),
        restaurantId,
        name: String(input.name || existing?.name || 'Guest').trim(),
        nameLower: String(input.name || existing?.name || 'guest').trim().toLowerCase(),
        phoneE164: phone.e164,
        phoneDigits: phone.digits,
        email: input.email != null ? String(input.email).trim() : (existing?.email || ''),
        warehouse: input.warehouse != null ? String(input.warehouse).trim() : (existing?.warehouse || ''),
        city: input.city != null ? String(input.city).trim() : (existing?.city || ''),
        tags: Array.isArray(input.tags) ? input.tags.map((tag) => String(tag).trim()).filter(Boolean) : (existing?.tags || []),
        optIn: input.optIn != null ? Boolean(input.optIn) : Boolean(existing?.optIn),
        optInAt: input.optIn ? (existing?.optInAt || now) : (existing?.optInAt || null),
        optInSource: input.optIn ? (input.optInSource || existing?.optInSource) : (existing?.optInSource || null),
        optOutAt: input.optIn === false ? now : (input.optIn ? null : (existing?.optOutAt || null)),
        lastInboundAt: existing?.lastInboundAt || null,
        lastOutboundAt: existing?.lastOutboundAt || null,
        lastInteractionAt: existing?.lastInteractionAt || null,
        engagement: existing?.engagement || 'none',
        createdAt: existing?.createdAt || now,
        updatedAt: now,
    };
    if (existing && existing.id !== next.id) await store.delete('contacts', existing.id);
    await store.put('contacts', next.id, next);
    return next;
}

export async function setContactTags(store, restaurantId, contactId, tags) {
    const contact = await store.get('contacts', contactId);
    if (!contact || contact.restaurantId !== restaurantId) throw new MarketingError(404, 'not_found', 'Contact not found.');
    const next = {
        ...contact,
        tags: [...new Set((tags || []).map((tag) => String(tag).trim()).filter(Boolean))],
        updatedAt: nowIso(),
    };
    await store.put('contacts', contactId, next);
    return next;
}

export async function importContacts(store, restaurantId, { csv, mapping, commit = false }) {
    const settings = await settingsOf(store, restaurantId);
    const parsed = parseCsv(csv);
    if (!mapping?.phone) throw new MarketingError(400, 'mapping', 'Map a column to the phone number.');
    const existing = await store.list('contacts', [{ field: 'restaurantId', op: '==', value: restaurantId }]);
    const known = new Set(existing.map((contact) => contact.phoneDigits));
    const suppressions = await store.list('suppressions', [{ field: 'restaurantId', op: '==', value: restaurantId }]);
    const suppressed = new Set(suppressions.filter((row) => !row.liftedAt).map((row) => row.phoneDigits));
    const seen = new Set();
    const preview = [];

    for (const record of parsed.records) {
        const row = mapRow(record, mapping);
        const phone = normalizePhone(row.phone, settings.defaultCountryCode || '27');
        if (!phone.ok) {
            preview.push({ row: row.row, status: 'rejected', reason: phone.reason === 'missing' ? 'missing_phone' : 'invalid_phone', phone: row.phone });
            continue;
        }
        if (seen.has(phone.digits) || known.has(phone.digits)) {
            preview.push({ row: row.row, status: 'duplicate', reason: 'duplicate', phone: phone.e164, name: row.name });
            seen.add(phone.digits);
            continue;
        }
        seen.add(phone.digits);
        if (suppressed.has(phone.digits)) {
            preview.push({ row: row.row, status: 'rejected', reason: 'suppressed', phone: phone.e164, name: row.name });
            continue;
        }
        const wantsOptIn = isExplicitOptIn(row.optIn);
        if (wantsOptIn && !row.source) {
            preview.push({ row: row.row, status: 'rejected', reason: 'missing_opt_in_source', phone: phone.e164, name: row.name });
            continue;
        }
        preview.push({
            row: row.row,
            status: 'ready',
            reason: wantsOptIn ? null : 'no_marketing_consent',
            phone: phone.e164,
            digits: phone.digits,
            name: row.name || 'Guest',
            email: row.email,
            tags: row.tags,
            optIn: wantsOptIn,
            source: row.source,
        });
    }

    if (!commit) {
        return {
            preview,
            summary: summarizeImport(preview),
            imported: 0,
        };
    }

    let imported = 0;
    for (const row of preview) {
        if (row.status !== 'ready') continue;
        const now = nowIso();
        const id = contactDocId(restaurantId, row.digits);
        await store.put('contacts', id, {
            id,
            restaurantId,
            name: row.name,
            nameLower: row.name.toLowerCase(),
            phoneE164: row.phone,
            phoneDigits: row.digits,
            email: row.email || '',
            tags: row.tags || [],
            optIn: row.optIn,
            warehouse: row.warehouse || '',
            city: row.city || '',
            optInAt: row.optIn ? now : null,
            optInSource: row.optIn ? row.source : null,
            optOutAt: null,
            lastInboundAt: null,
            lastOutboundAt: null,
            lastInteractionAt: null,
            engagement: 'none',
            createdAt: now,
            updatedAt: now,
        });
        imported += 1;
    }
    await audit(store, restaurantId, 'contacts.import', { imported, rejected: preview.length - imported });
    return { preview, summary: summarizeImport(preview), imported };
}

function summarizeImport(preview) {
    return preview.reduce((acc, row) => {
        acc.rows += 1;
        acc[row.status] = (acc[row.status] || 0) + 1;
        if (row.status === 'ready' && row.optIn) acc.eligible = (acc.eligible || 0) + 1;
        if (row.status === 'ready' && !row.optIn) acc.storedWithoutConsent = (acc.storedWithoutConsent || 0) + 1;
        return acc;
    }, { rows: 0, ready: 0, rejected: 0, duplicate: 0, eligible: 0, storedWithoutConsent: 0 });
}

export async function exportContacts(store, restaurantId, { optedInOnly = true } = {}) {
    const contacts = await store.list('contacts', [{ field: 'restaurantId', op: '==', value: restaurantId }]);
    const rows = contacts.filter((contact) => !optedInOnly || (contact.optIn && !contact.optOutAt));
    const header = 'name,phone,email,opt_in,opt_in_source,tags';
    const body = rows.map((contact) => [
        contact.name, contact.phoneE164, contact.email || '', contact.optIn ? 'yes' : 'no', contact.optInSource || '', (contact.tags || []).join('|'),
    ].map(csvCell).join(','));
    return `${header}\n${body.join('\n')}\n`;
}

function csvCell(value) {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function listTemplates(store, restaurantId) {
    const templates = await store.list('templates', [{ field: 'restaurantId', op: '==', value: restaurantId }]);
    return templates.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function saveTemplate(store, restaurantId, draft, templateId = null) {
    const validated = validateTemplateDraft(draft);
    if (!validated.ok && draft.submit) throw new MarketingError(400, 'invalid_template', validated.errors.join(' '));
    const id = templateId || randomUUID();
    const existing = templateId ? await store.get('templates', id) : null;
    if (templateId && (!existing || existing.restaurantId !== restaurantId)) {
        throw new MarketingError(404, 'not_found', 'Template not found.');
    }
    if (existing && !['draft', 'rejected'].includes(existing.status)) {
        throw new MarketingError(409, 'locked', 'Only a draft or rejected template can be edited. Submit a new template for an approved one.');
    }
    const now = nowIso();
    const next = {
        id,
        restaurantId,
        name: String(draft.name || '').trim(),
        category: String(draft.category || 'MARKETING').toUpperCase(),
        language: draft.language || 'en',
        header: draft.header || null,
        body: draft.body || '',
        footer: draft.footer || '',
        buttons: draft.buttons || [],
        examples: draft.examples || [],
        status: existing?.status || 'draft',
        metaId: existing?.metaId || null,
        metaName: existing?.metaName || null,
        rejectionReason: existing?.rejectionReason || null,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
    };
    if (!draft.submit) {
        const check = validateTemplateDraft(next);
        next.validationErrors = check.ok ? [] : check.errors;
    }
    await store.put('templates', id, next);
    return next;
}

export async function submitTemplate(store, meta, restaurantId, templateId) {
    const template = await store.get('templates', templateId);
    if (!template || template.restaurantId !== restaurantId) throw new MarketingError(404, 'not_found', 'Template not found.');
    const check = validateTemplateDraft(template);
    if (!check.ok) throw new MarketingError(400, 'invalid_template', check.errors.join(' '));
    const result = await meta.create(toMetaCreatePayload(template));
    if (!result.ok) throw new MarketingError(result.status || 502, result.code || 'meta_error', result.error || 'Meta rejected the template request.');
    const status = mapMetaTemplateStatus(result.status);
    const next = {
        ...template,
        status,
        metaId: result.id || template.metaId,
        metaName: template.name,
        rejectionReason: status === 'rejected' ? (result.rejectionReason || null) : null,
        submittedAt: nowIso(),
        updatedAt: nowIso(),
    };
    await store.put('templates', templateId, next);
    await audit(store, restaurantId, 'template.submit', { templateId, status, metaId: next.metaId });
    return next;
}

export async function syncTemplates(store, meta, restaurantId) {
    const result = await meta.list();
    if (!result.ok) throw new MarketingError(result.status || 502, result.code || 'meta_error', result.error || 'Could not read templates from Meta.');
    const local = await store.list('templates', [{ field: 'restaurantId', op: '==', value: restaurantId }]);
    const byMeta = new Map(local.filter((item) => item.metaId).map((item) => [String(item.metaId), item]));
    const byName = new Map(local.map((item) => [`${item.name}:${item.language}`, item]));
    const seen = new Set();
    for (const remote of result.templates || []) {
        const status = mapMetaTemplateStatus(remote.status);
        const key = `${remote.name}:${remote.language}`;
        const existing = byMeta.get(String(remote.id)) || byName.get(key);
        const id = existing?.id || randomUUID();
        seen.add(id);
        await store.put('templates', id, {
            id,
            restaurantId,
            name: remote.name,
            category: remote.category || existing?.category || 'MARKETING',
            language: remote.language || 'en',
            header: existing?.header || null,
            body: remote.body || existing?.body || '',
            footer: existing?.footer || '',
            buttons: existing?.buttons || [],
            examples: existing?.examples || [],
            status,
            metaId: remote.id ? String(remote.id) : null,
            metaName: remote.name,
            rejectionReason: remote.rejected_reason || remote.rejectionReason || null,
            createdAt: existing?.createdAt || nowIso(),
            updatedAt: nowIso(),
        });
    }
    return listTemplates(store, restaurantId);
}

export async function deleteTemplate(store, meta, restaurantId, templateId) {
    const template = await store.get('templates', templateId);
    if (!template || template.restaurantId !== restaurantId) throw new MarketingError(404, 'not_found', 'Template not found.');
    const campaigns = await store.list('campaigns', [{ field: 'restaurantId', op: '==', value: restaurantId }]);
    if (campaigns.some((item) => item.templateId === templateId && ['queued', 'running', 'scheduled'].includes(item.status))) {
        throw new MarketingError(409, 'in_use', 'This template is used by a campaign that is still sending.');
    }
    if (template.metaName && template.status !== 'draft') {
        const removed = await meta.remove(template.metaName);
        if (!removed.ok && removed.code !== 'NOT_CONFIGURED') {
            throw new MarketingError(removed.status || 502, 'meta_error', removed.error || 'Meta did not delete the template.');
        }
    }
    await store.delete('templates', templateId);
    return { deleted: true };
}

export async function previewAudience(store, restaurantId, audience) {
    const settings = await settingsOf(store, restaurantId);
    const contacts = await store.list('contacts', [{ field: 'restaurantId', op: '==', value: restaurantId }]);
    const suppressions = await store.list('suppressions', [{ field: 'restaurantId', op: '==', value: restaurantId }]);
    return splitAudience(contacts, suppressions, audience || { type: 'all' }, settings);
}

export async function createCampaign(store, restaurantId, input) {
    const now = nowIso();
    const id = randomUUID();
    const campaign = {
        id,
        restaurantId,
        name: String(input.name || '').trim(),
        description: String(input.description || '').trim(),
        purpose: String(input.purpose || '').trim(),
        templateId: input.templateId || null,
        audience: input.audience || { type: 'all' },
        variableMapping: input.variableMapping || [],
        sendAt: input.sendAt || null,
        status: 'draft',
        metrics: null,
        summary: null,
        createdAt: now,
        updatedAt: now,
    };
    if (!campaign.name) throw new MarketingError(400, 'name', 'Campaign name is required.');
    await store.put('campaigns', id, campaign);
    await audit(store, restaurantId, 'campaign.create', { campaignId: id });
    return campaign;
}

export async function updateCampaign(store, restaurantId, campaignId, input) {
    const campaign = await ownedCampaign(store, restaurantId, campaignId);
    if (campaign.status !== 'draft') throw new MarketingError(409, 'locked', 'Only a draft campaign can be edited.');
    const next = {
        ...campaign,
        name: input.name != null ? String(input.name).trim() : campaign.name,
        description: input.description != null ? String(input.description) : campaign.description,
        purpose: input.purpose != null ? String(input.purpose) : campaign.purpose,
        templateId: input.templateId != null ? input.templateId : campaign.templateId,
        audience: input.audience || campaign.audience,
        variableMapping: input.variableMapping || campaign.variableMapping,
        sendAt: input.sendAt !== undefined ? input.sendAt : campaign.sendAt,
        updatedAt: nowIso(),
    };
    await store.put('campaigns', campaignId, next);
    return next;
}

async function ownedCampaign(store, restaurantId, campaignId) {
    const campaign = await store.get('campaigns', campaignId);
    if (!campaign || campaign.restaurantId !== restaurantId) throw new MarketingError(404, 'not_found', 'Campaign not found.');
    return campaign;
}

export async function launchCampaign(store, restaurantId, campaignId, { confirm, restaurantName } = {}) {
    if (confirm !== true) throw new MarketingError(400, 'confirm', 'Launch needs an explicit confirmation.');
    const campaign = await ownedCampaign(store, restaurantId, campaignId);
    if (!['draft', 'scheduled'].includes(campaign.status)) {
        throw new MarketingError(409, 'locked', 'This campaign has already been launched.');
    }
    const template = await store.get('templates', campaign.templateId);
    if (!template || template.restaurantId !== restaurantId || !campaignIsSendable(template)) {
        throw new MarketingError(400, 'template', 'Choose an approved marketing template before launching.');
    }
    const preview = await previewAudience(store, restaurantId, campaign.audience);
    if (preview.eligible.length === 0) throw new MarketingError(400, 'audience', 'No eligible opted-in contacts match this audience.');
    const sample = preview.eligible[0];
    const mapped = bodyParameters(template, campaign.variableMapping, sample, restaurantName);
    if (!mapped.ok) throw new MarketingError(400, mapped.reason, 'Map every template variable before launching.');

    const stamp = nowIso();
    const pendingRows = [];
    for (const contact of preview.eligible) {
        const id = recipientDocId(campaign.id, contact.phoneDigits);
        const existing = await store.get('recipients', id);
        if (existing?.wamid) continue;
        pendingRows.push({ status: 'pending' });
        await store.put('recipients', id, {
            id,
            campaignId: campaign.id,
            restaurantId,
            contactId: contact.id,
            phoneDigits: contact.phoneDigits,
            phoneE164: contact.phoneE164,
            status: 'pending',
            attempts: existing?.attempts || 0,
            wamid: null,
            createdAt: existing?.createdAt || stamp,
            updatedAt: stamp,
        });
    }
    const sendAt = campaign.sendAt && Date.parse(campaign.sendAt) > Date.now() ? campaign.sendAt : null;
    const next = {
        ...campaign,
        restaurantName: restaurantName || campaign.restaurantName || '',
        status: sendAt ? 'scheduled' : 'queued',
        metrics: recount(pendingRows),
        summary: preview.summary,
        excluded: preview.excluded.slice(0, 200),
        launchedAt: stamp,
        updatedAt: stamp,
    };
    await store.put('campaigns', campaign.id, next);
    await audit(store, restaurantId, 'campaign.launch', { campaignId, eligible: preview.summary.eligible, status: next.status });
    return { campaign: next, summary: preview.summary };
}

export async function setCampaignControl(store, restaurantId, campaignId, action) {
    const campaign = await ownedCampaign(store, restaurantId, campaignId);
    const now = nowIso();
    if (action === 'pause') {
        if (campaign.status !== 'running' && campaign.status !== 'queued') {
            throw new MarketingError(409, 'state', 'Only a running campaign can be paused.');
        }
        campaign.status = 'paused';
    } else if (action === 'resume') {
        if (campaign.status !== 'paused') throw new MarketingError(409, 'state', 'Only a paused campaign can be resumed.');
        campaign.status = 'running';
    } else if (action === 'cancel') {
        if (['completed', 'cancelled'].includes(campaign.status)) {
            throw new MarketingError(409, 'state', 'This campaign is already finished.');
        }
        campaign.status = 'cancelled';
        let metrics = campaign.metrics;
        for (;;) {
            const pending = await store.query('recipients', {
                filters: [
                    { field: 'campaignId', op: '==', value: campaignId },
                    { field: 'status', op: '==', value: 'pending' },
                ],
                orderBy: { field: 'createdAt', direction: 'asc' },
                limit: 100,
            });
            if (!pending.length) break;
            for (const row of pending) {
                await store.put('recipients', row.id, { ...row, status: 'cancelled', updatedAt: now });
                if (metrics?.byStatus) metrics = shiftMetric(metrics, 'pending', 'cancelled');
            }
            if (pending.length < 100) break;
        }
        campaign.metrics = metrics || campaign.metrics;
    } else if (action === 'retry') {
        const failed = await store.query('recipients', {
            filters: [
                { field: 'campaignId', op: '==', value: campaignId },
                { field: 'status', op: '==', value: 'failed' },
            ],
            limit: 100,
        });
        let metrics = campaign.metrics;
        let retried = 0;
        for (const row of failed) {
            if (row.wamid || row.reason === 'opted_out' || row.reason === 'suppressed' || row.reason === 'invalid_phone') continue;
            await store.put('recipients', row.id, {
                ...row,
                status: 'pending',
                nextAttemptAt: null,
                dispatchStartedAt: null,
                claimedAt: null,
                leaseExpiresAt: null,
                updatedAt: now,
            });
            if (metrics?.byStatus) metrics = shiftMetric(metrics, 'failed', 'pending');
            retried += 1;
        }
        if (!retried) throw new MarketingError(400, 'nothing_to_retry', 'No failed recipients can be retried safely.');
        campaign.status = 'running';
        campaign.retried = retried;
        campaign.metrics = metrics || campaign.metrics;
    } else {
        throw new MarketingError(400, 'action', 'Unknown campaign action.');
    }
    campaign.updatedAt = now;
    await store.put('campaigns', campaignId, campaign);
    await audit(store, restaurantId, `campaign.${action}`, { campaignId });
    return campaign;
}

export async function getCampaign(store, restaurantId, campaignId) {
    const campaign = await ownedCampaign(store, restaurantId, campaignId);
    if (campaign.metrics?.byStatus) return campaign;
    const recipients = await store.list('recipients', [{ field: 'campaignId', op: '==', value: campaignId }]);
    return { ...campaign, metrics: recount(recipients) };
}

export async function listCampaigns(store, restaurantId) {
    const campaigns = await store.list('campaigns', [{ field: 'restaurantId', op: '==', value: restaurantId }]);
    return campaigns.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function listRecipients(store, restaurantId, campaignId, query = {}) {
    await ownedCampaign(store, restaurantId, campaignId);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
    const filters = [{ field: 'campaignId', op: '==', value: campaignId }];
    if (query.status) filters.push({ field: 'status', op: '==', value: query.status });
    const rows = await store.query('recipients', {
        filters,
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit,
    });
    const named = [];
    for (const row of rows) {
        if (row.restaurantId !== restaurantId) continue;
        const contact = row.contactId ? await store.get('contacts', row.contactId) : null;
        named.push({ ...row, name: contact?.name || '' });
    }
    return named;
}

export async function importCampaignLeads(store, restaurantId, campaignId, { csv, confirm, optInSource } = {}) {
    if (confirm !== true) throw new MarketingError(400, 'confirm', 'Confirm these people opted in before importing them.');
    const source = String(optInSource || '').trim();
    if (!source) throw new MarketingError(400, 'missing_opt_in_source', 'Name where these people opted in, such as a form or a stand.');
    const campaign = await ownedCampaign(store, restaurantId, campaignId);
    const parsed = parseCsv(csv);
    if (!parsed.records.length) throw new MarketingError(400, 'empty_csv', 'The CSV has no data rows.');
    const headers = parsed.headers;
    const findHeader = (...names) => headers.find((header) => names.includes(header.toLowerCase())) || '';
    const first = findHeader('first name', 'firstname');
    const last = findHeader('last name', 'lastname');
    const name = findHeader('name', 'full name');
    const phone = findHeader('phone', 'phone number', 'whatsapp', 'mobile', 'number');
    if (!phone || (!name && !first)) {
        throw new MarketingError(400, 'csv_columns', 'The CSV needs Name (or First name and Last name) and Phone number columns.');
    }
    const template = await store.get('templates', campaign.templateId);
    const canQueue = ['queued', 'running', 'paused', 'completed'].includes(campaign.status) && campaignIsSendable(template);
    let imported = 0;
    let queued = 0;
    let skipped = 0;
    const problems = [];
    for (const record of parsed.records) {
        const person = [record[first], record[last]].filter(Boolean).join(' ').trim() || String(record[name] || '').trim();
        const number = String(record[phone] || '').trim();
        try {
            const contact = await saveContact(store, restaurantId, {
                name: person || 'Guest',
                phone: number,
                optIn: true,
                optInSource: source,
            });
            imported += 1;
            if (!canQueue) continue;
            const id = recipientDocId(campaign.id, contact.phoneDigits);
            const existing = await store.get('recipients', id);
            if (existing?.wamid || ['sent', 'delivered', 'read', 'replied', 'sending', 'pending'].includes(existing?.status)) {
                skipped += 1;
                continue;
            }
            const stamp = nowIso();
            await store.put('recipients', id, {
                id,
                campaignId: campaign.id,
                restaurantId,
                contactId: contact.id,
                phoneDigits: contact.phoneDigits,
                phoneE164: contact.phoneE164,
                status: 'pending',
                attempts: existing?.attempts || 0,
                wamid: existing?.wamid || null,
                createdAt: existing?.createdAt || stamp,
                updatedAt: stamp,
            });
            queued += 1;
        } catch (error) {
            problems.push({ row: record.__row, error: error.message });
        }
    }
    if (queued) {
        let metrics = campaign.metrics;
        if (metrics?.byStatus) {
            for (let i = 0; i < queued; i += 1) metrics = shiftMetric(metrics, null, 'pending');
        }
        const next = { ...campaign, metrics: metrics || campaign.metrics, updatedAt: nowIso() };
        if (campaign.status === 'completed') next.status = 'running';
        await store.put('campaigns', campaign.id, next);
    }
    await audit(store, restaurantId, 'campaign.import_leads', { campaignId, imported, queued, skipped });
    return {
        imported,
        queued,
        skipped,
        problems: problems.slice(0, 20),
        waitingForLaunch: ['draft', 'scheduled'].includes(campaign.status),
    };
}

export async function repairConversationSummaries(store, restaurantId) {
    const rows = await store.list('conversations', [{ field: 'restaurantId', op: '==', value: restaurantId }]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const messages = await store.list('messages', [{ field: 'restaurantId', op: '==', value: restaurantId }]);
    let repaired = 0;
    for (const message of messages) {
        if (!message.conversationId || byId.has(message.conversationId)) continue;
        const contact = message.contactId ? await store.get('contacts', message.contactId) : null;
        const conversation = {
            id: message.conversationId,
            restaurantId,
            contactId: message.contactId || null,
            phoneDigits: message.phoneDigits,
            name: contact?.name || 'Guest',
            handler: 'ai',
            campaignId: message.campaignId || null,
            lastMessage: message.body || '',
            lastMessageKind: message.kind === 'template' ? 'template' : (message.direction === 'inbound' ? 'customer' : 'ai'),
            templateName: message.templateName || null,
            unread: 0,
            createdAt: message.createdAt,
            updatedAt: message.createdAt,
        };
        await store.put('conversations', conversation.id, conversation);
        byId.set(conversation.id, conversation);
        repaired += 1;
    }
    return { repaired };
}

export async function listConversations(store, restaurantId, query = {}) {
    const filters = [{ field: 'restaurantId', op: '==', value: restaurantId }];
    if (query.handler) filters.push({ field: 'handler', op: '==', value: query.handler });
    if (query.campaignId) filters.push({ field: 'campaignId', op: '==', value: query.campaignId });
    const needle = String(query.q || '').trim().toLowerCase();
    let listed;
    let total;
    if (needle || query.unread === 'true') {
        listed = (await store.list('conversations', filters))
            .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
        if (query.unread === 'true') listed = listed.filter((item) => (item.unread || 0) > 0);
        if (needle) {
            listed = listed.filter((item) => `${item.name || ''} ${item.phoneDigits || ''} ${item.lastMessage || ''}`.toLowerCase().includes(needle));
        }
        total = listed.length;
        if (query.limit) {
            const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
            const offset = Math.max(0, Number(query.offset) || 0);
            listed = listed.slice(offset, offset + limit);
        }
        return { conversations: listed, total };
    }
    total = await store.count('conversations', filters);
    const limit = query.limit ? Math.min(100, Math.max(1, Number(query.limit) || 50)) : undefined;
    const offset = Math.max(0, Number(query.offset) || 0);
    listed = await store.query('conversations', {
        filters,
        orderBy: { field: 'updatedAt', direction: 'desc' },
        limit,
        offset,
    });
    return { conversations: listed, total };
}

export async function getConversation(store, restaurantId, conversationId, query = {}) {
    const conversation = await store.get('conversations', conversationId);
    if (!conversation || conversation.restaurantId !== restaurantId) {
        throw new MarketingError(404, 'not_found', 'Conversation not found.');
    }
    const limit = Math.min(50, Math.max(1, Number(query.limit) || 30));
    const page = await store.query('messages', {
        filters: [{ field: 'conversationId', op: '==', value: conversationId }],
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit: limit + 1,
        startAfter: query.before || undefined,
    });
    const hasMore = page.length > limit;
    const slice = page.slice(0, limit).filter((item) => item.restaurantId === restaurantId);
    const messages = [...slice].reverse();
    const contact = conversation.contactId ? await store.get('contacts', conversation.contactId) : null;
    return {
        ...conversation,
        windowOpen: customerWindowOpen(conversation),
        contact: contact && contact.restaurantId === restaurantId ? contact : null,
        messages,
        nextBefore: hasMore ? slice[slice.length - 1]?.createdAt || null : null,
    };
}

export async function sendHumanMessage(store, sender, restaurantId, conversationId, { text, actor }) {
    const conversation = await store.get('conversations', conversationId);
    if (!conversation || conversation.restaurantId !== restaurantId) {
        throw new MarketingError(404, 'not_found', 'Conversation not found.');
    }
    if (conversation.handler === 'ai') {
        throw new MarketingError(409, 'ai_active', 'Take over the conversation before a person sends a message.');
    }
    if (!customerWindowOpen(conversation)) {
        throw new MarketingError(409, 'window_closed', 'The 24-hour window is closed. Send an approved template instead of a free-form message.');
    }
    const body = String(text || '').trim();
    if (!body) throw new MarketingError(400, 'empty', 'Message text is required.');
    const contact = await store.get('contacts', conversation.contactId);
    const result = await sender.sendText(contact.phoneE164, body);
    if (!result?.ok) throw new MarketingError(502, 'send_failed', result?.error || 'WhatsApp did not accept the message.');
    const stamp = nowIso();
    const id = result.messageId || randomUUID();
    await store.put('messages', id, {
        id,
        restaurantId,
        conversationId,
        contactId: contact.id,
        phoneDigits: contact.phoneDigits,
        direction: 'outbound',
        kind: 'text',
        body,
        status: 'sent',
        wamid: result.messageId || null,
        actor: actor || 'human',
        createdAt: stamp,
    });
    await store.put('conversations', conversationId, { ...conversation, updatedAt: stamp, lastMessage: body, lastMessageKind: 'human' });
    return { id, status: 'sent' };
}

export async function setConversationMode(store, restaurantId, conversationId, mode, actor) {
    const conversation = await store.get('conversations', conversationId);
    if (!conversation || conversation.restaurantId !== restaurantId) {
        throw new MarketingError(404, 'not_found', 'Conversation not found.');
    }
    if (!['ai', 'human', 'resolved'].includes(mode)) throw new MarketingError(400, 'mode', 'Mode must be ai, human, or resolved.');
    const next = {
        ...conversation,
        handler: mode,
        assignedTo: mode === 'human' ? (actor || 'staff') : null,
        updatedAt: nowIso(),
    };
    await store.put('conversations', conversationId, next);
    await audit(store, restaurantId, 'conversation.mode', { conversationId, mode });
    return next;
}

export async function getSettings(store, restaurantId) {
    return settingsOf(store, restaurantId);
}

export async function saveSettings(store, restaurantId, input) {
    const current = await settingsOf(store, restaurantId);
    const next = {
        ...current,
        restaurantId,
        menuUrl: input.menuUrl != null ? String(input.menuUrl).trim() : (current.menuUrl || ''),
        defaultCountryCode: String(input.defaultCountryCode || current.defaultCountryCode || '27').replace(/\D/g, '') || '27',
        offers: Array.isArray(input.offers) ? input.offers.map(cleanFact) : (current.offers || []),
        events: Array.isArray(input.events) ? input.events.map(cleanFact) : (current.events || []),
        updatedAt: nowIso(),
    };
    await store.put('settings', restaurantId, next);
    return next;
}

function cleanFact(item) {
    return {
        id: item.id || randomUUID(),
        title: String(item.title || '').trim(),
        details: String(item.details || '').trim(),
        when: item.when ? String(item.when) : '',
    };
}

export async function getAnalytics(store, restaurantId) {
    const overview = await getOverview(store, restaurantId);
    const campaigns = await listCampaigns(store, restaurantId);
    const messages = await store.list('messages', [{ field: 'restaurantId', op: '==', value: restaurantId }]);
    const days = [];
    for (let offset = 13; offset >= 0; offset -= 1) {
        const day = new Date();
        day.setUTCDate(day.getUTCDate() - offset);
        const key = day.toISOString().slice(0, 10);
        const rows = messages.filter((item) => String(item.createdAt || '').startsWith(key) && item.direction === 'outbound');
        const metrics = recount(rows.map((item) => ({ status: item.status })));
        days.push({ date: key, sent: metrics.sent, delivered: metrics.delivered, read: metrics.read, replied: metrics.replied, failed: metrics.failed });
    }
    return {
        overview,
        series: days,
        campaigns: campaigns.map((item) => ({
            id: item.id,
            name: item.name,
            status: item.status,
            metrics: item.metrics,
        })),
    };
}

export async function optOutContact(store, restaurantId, phoneDigits, source) {
    const id = contactDocId(restaurantId, phoneDigits);
    const contact = await store.get('contacts', id);
    const stamp = nowIso();
    if (contact) {
        await store.put('contacts', id, { ...contact, optIn: false, optOutAt: stamp, updatedAt: stamp });
    }
    await store.put('suppressions', suppressionDocId(restaurantId, phoneDigits), {
        id: suppressionDocId(restaurantId, phoneDigits),
        restaurantId,
        phoneDigits,
        source: source || 'whatsapp_stop',
        createdAt: stamp,
        liftedAt: null,
    });
}

export async function recordInbound(store, { restaurantId, phoneDigits, name, text, wamid, campaignId, contactId, reopenForCampaign = false }) {
    const stamp = nowIso();
    const conversationId = conversationDocId(restaurantId, phoneDigits);
    const existing = await store.get('conversations', conversationId);
    const conversation = {
        id: conversationId,
        restaurantId,
        contactId: contactId || contactDocId(restaurantId, phoneDigits),
        phoneDigits,
        name: name || existing?.name || 'Guest',
        handler: existing?.handler && existing.handler !== 'booking' ? existing.handler : (existing?.handler || 'ai'),
        campaignId: campaignId || existing?.campaignId || null,
        lastCustomerMessageAt: stamp,
        lastMessage: text,
        lastMessageKind: 'customer',
        unread: (existing?.unread || 0) + 1,
        createdAt: existing?.createdAt || stamp,
        updatedAt: stamp,
        assignedTo: existing?.assignedTo || null,
    };
    if (existing?.handler === 'resolved') conversation.handler = 'resolved';
    if (existing?.handler === 'human') conversation.handler = 'human';
    if (existing?.handler === 'booking') conversation.handler = 'booking';
    if (reopenForCampaign && conversation.handler === 'booking') conversation.handler = 'ai';
    await store.put('conversations', conversationId, conversation);
    await store.put('messages', wamid, {
        id: wamid,
        restaurantId,
        conversationId,
        contactId: conversation.contactId,
        phoneDigits,
        campaignId: conversation.campaignId,
        direction: 'inbound',
        kind: 'text',
        body: text,
        status: 'received',
        wamid,
        createdAt: stamp,
    });
    const contact = await store.get('contacts', conversation.contactId);
    if (contact && contact.restaurantId === restaurantId) {
        await store.put('contacts', contact.id, {
            ...contact,
            lastInboundAt: stamp,
            lastInteractionAt: stamp,
            engagement: 'replied',
            name: contact.name || name || contact.name,
            updatedAt: stamp,
        });
    }
    return conversation;
}

export async function recordOutboundAi(store, conversation, { text, wamid }) {
    const stamp = nowIso();
    const id = wamid || randomUUID();
    await store.put('messages', id, {
        id,
        restaurantId: conversation.restaurantId,
        conversationId: conversation.id,
        contactId: conversation.contactId,
        phoneDigits: conversation.phoneDigits,
        campaignId: conversation.campaignId,
        direction: 'outbound',
        kind: 'text',
        body: text,
        status: wamid ? 'sent' : 'failed',
        wamid: wamid || null,
        actor: 'ai',
        createdAt: stamp,
    });
    await store.put('conversations', conversation.id, {
        ...conversation,
        lastMessage: text,
        lastMessageKind: 'ai',
        updatedAt: stamp,
    });
}

export { applyDeliveryUpdate, progressCampaign, recoverStuckRecipients };
