import logger from '../../utils/logger.js';
import { getTenantById } from '../tenantService.js';
import { getAvailableCapacityForDate } from '../capacityService.js';
import manualBookingService from '../manualBookingService.js';
import { decodeBody, gmailGet, gmailSend, encodeRawMessage, header, refreshAccessToken } from './gmail.js';
import { todayInTz } from '../whatsapp/whatsappDateTime.js';
import { classifyEmail, composeReply, extractBookingDetails, freshEmailText, guestNameFrom, isConfirmation, mergeDraft, missingFields } from './parse.js';
import { accounts, claimMessage, getAccount, messages, publicAccount, threads, tokensOf } from './accounts.js';

const googleConfig = () => ({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
});

export async function accessTokenFor(account) {
    const tokens = tokensOf(account);
    const expires = Date.parse(account.accessTokenExpiresAt || 0);
    if (tokens.accessToken && expires - Date.now() > 60_000) return tokens.accessToken;
    const refreshed = await refreshAccessToken({
        refreshToken: tokens.refreshToken,
        ...googleConfig(),
    });
    const next = refreshed.access_token;
    const { encryptSecret } = await import('./crypto.js');
    await accounts().doc(account.restaurantId).set({
        accessTokenEnc: encryptSecret(next),
        accessTokenExpiresAt: new Date(Date.now() + (Number(refreshed.expires_in) || 3600) * 1000).toISOString(),
        refreshTokenEnc: refreshed.refresh_token ? encryptSecret(refreshed.refresh_token) : account.refreshTokenEnc,
    }, { merge: true });
    return next;
}

export async function syncAccount(restaurantId) {
    const account = await getAccount(restaurantId);
    if (!account || account.status !== 'connected') return publicAccount(account);
    const token = await accessTokenFor(account);
    if (!account.historyId) {
        const profile = await gmailGet('/profile', token);
        await accounts().doc(account.restaurantId).set({
            historyId: profile.historyId,
            lastSyncAt: new Date().toISOString(),
            lastError: null,
        }, { merge: true });
        return publicAccount(await getAccount(restaurantId));
    }
    let pageToken = '';
    let historyId = account.historyId;
    const ids = [];
    try {
        do {
            const query = new URLSearchParams({ startHistoryId: String(account.historyId), historyTypes: 'messageAdded' });
            if (pageToken) query.set('pageToken', pageToken);
            const page = await gmailGet(`/history?${query}`, token);
            historyId = page.historyId || historyId;
            for (const item of page.history || []) {
                for (const added of item.messagesAdded || []) {
                    if (added.message?.id) ids.push(added.message.id);
                }
            }
            pageToken = page.nextPageToken || '';
        } while (pageToken);
    } catch (error) {
        if (error.status === 404) {
            const profile = await gmailGet('/profile', token);
            await accounts().doc(account.restaurantId).set({ historyId: profile.historyId, lastError: 'Gmail history expired. Sync restarted from now.' }, { merge: true });
            return publicAccount(await getAccount(restaurantId));
        }
        throw error;
    }
    for (const id of [...new Set(ids)]) {
        await handleMessage(account, token, id);
    }
    await accounts().doc(account.restaurantId).set({
        historyId,
        lastSyncAt: new Date().toISOString(),
        lastError: null,
    }, { merge: true });
    return publicAccount(await getAccount(restaurantId));
}

async function handleMessage(account, token, messageId) {
    const claimed = await claimMessage(messageId);
    if (!claimed) return;
    const message = await gmailGet(`/messages/${messageId}?format=full`, token);
    const from = header(message, 'From');
    const subject = header(message, 'Subject');
    const messageIdHeader = header(message, 'Message-ID') || header(message, 'Message-Id');
    const body = decodeBody(message);
    const own = account.email && from.toLowerCase().includes(account.email.toLowerCase());
    const threadId = message.threadId;
    const docId = `${account.restaurantId}_${threadId}`;
    const threadRef = threads().doc(docId);
    const existingSnap = await threadRef.get();
    const existing = existingSnap.exists ? existingSnap.data() : {};
    if (own && await outboundAlreadyStored(account.restaurantId, threadId, body)) return;
    await messages().doc(messageId).set({
        id: messageId,
        restaurantId: account.restaurantId,
        threadId,
        from,
        subject,
        body: body.slice(0, 4000),
        direction: own ? 'outbound' : 'inbound',
        at: new Date(Number(message.internalDate) || Date.now()).toISOString(),
    });
    if (own) return;
    await accounts().doc(account.restaurantId).set({ incoming: (account.incoming || 0) + 1 }, { merge: true });
    account.incoming = (account.incoming || 0) + 1;
    if (existing.autoReply === false) {
        await threadRef.set({
            ...baseThread(account, threadId, from, subject, existing),
            autoReply: false,
            status: existing.status || 'pending',
            preview: body.slice(0, 180),
            lastInboundId: messageIdHeader,
        }, { merge: true });
        return;
    }
    if (account.automationEnabled === false) {
        await threadRef.set({
            ...baseThread(account, threadId, from, subject, existing),
            status: 'paused',
            preview: body.slice(0, 180),
        }, { merge: true });
        return;
    }
    const kind = classifyEmail({ subject, body });
    if (kind === 'ignore') {
        await threadRef.set({ ...baseThread(account, threadId, from, subject, existing), status: 'ignored', preview: body.slice(0, 180) }, { merge: true });
        return;
    }
    if (kind === 'review') {
        await threadRef.set({ ...baseThread(account, threadId, from, subject, existing), status: 'review', preview: body.slice(0, 180) }, { merge: true });
        await bump(account, 'pending');
        return;
    }
    const tenant = await getTenantById(account.restaurantId);
    const today = todayInTz(tenant?.settings?.timezone || 'Africa/Johannesburg');
    const guestName = guestNameFrom(from, body) || existing.draft?.name;
    const draft = await draftFromThread({ account, threadId, subject, body, today, guestName, paymentId: existing.draft?.paymentId || null });
    const replyTo = addressFrom(from);
    const letter = { restaurantName: tenant?.name || 'Reservations', guestName: draft.name, draft, today };
    let reply = '';
    let status = 'pending';
    if (existing.status === 'awaiting_confirm' && isConfirmation(freshEmailText(body)) && !missingFields(existing.draft || {}).length) {
        const booked = await bookDraft(account, existing.draft, threadId, letter);
        reply = booked.reply;
        status = booked.status;
        draft.paymentId = booked.paymentId || null;
    } else if (draft.date && draft.date < today) {
        reply = composeReply({ ...letter, missing: [] });
        status = 'pending';
    } else if (draft.date && draft.time) {
        const check = await getAvailableCapacityForDate(null, account.restaurantId, draft.date, draft.time);
        if (check.checkFailed) {
            status = 'review';
            reply = '';
        } else if (check.isOpen === false || check.fullyBooked) {
            reply = composeReply({ ...letter, availability: 'unavailable', missing: [] });
            status = 'pending';
            draft.time = null;
        } else {
            const missing = missingFields(draft);
            reply = composeReply({ ...letter, availability: 'open', missing });
            status = missing.length ? 'pending' : 'awaiting_confirm';
        }
    } else {
        reply = composeReply({ ...letter, missing: missingFields(draft) });
        status = 'pending';
    }
    await threadRef.set({
        ...baseThread(account, threadId, from, subject, existing),
        status,
        draft,
        preview: body.slice(0, 180),
        lastInboundId: messageIdHeader,
    }, { merge: true });
    if (reply && replyTo) {
        try {
            await sendReply({ account, token, to: replyTo, subject, body: reply, threadId, inReplyTo: messageIdHeader });
        } catch (error) {
            logger.error(`Email reply failed: ${error.message}`);
            await threadRef.set({ status: 'failed' }, { merge: true });
            await bump(account, 'failed');
        }
    }
    await bump(account, status === 'booked' ? 'processed' : 'pending');
}

async function draftFromThread({ account, threadId, subject, body, today, guestName, paymentId }) {
    const snap = await messages().where('threadId', '==', threadId).limit(40).get();
    const inbound = snap.docs
        .map((doc) => doc.data())
        .filter((row) => row.restaurantId === String(account.restaurantId) && row.direction === 'inbound')
        .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    let draft = mergeDraft({ paymentId }, extractBookingDetails(subject || '', today), guestName);
    const sources = inbound.length ? inbound.map((row) => row.body || '') : [body];
    for (const source of sources) {
        draft = mergeDraft(draft, extractBookingDetails(source, today), guestName);
    }
    return draft;
}

async function bookDraft(account, draft, threadId, letter) {
    try {
        const created = await manualBookingService.createManualBooking(account.restaurantId, {
            name: draft.name || 'Guest',
            phoneNo: draft.phone,
            guests: Number(draft.guests),
            date: draft.date,
            time: draft.time,
        }, {
            source: 'email',
            extraFields: { channel: 'email', gmailThreadId: threadId },
        });
        return {
            status: 'booked',
            paymentId: created.paymentId,
            reply: composeReply({ ...letter, draft, paymentId: created.paymentId, bookingId: created.bookingId }),
        };
    } catch (error) {
        logger.error(`Email booking failed: ${error.message}`);
        return { status: 'review', reply: '' };
    }
}

export async function setThreadAutoReply(restaurantId, threadId, enabled) {
    const ref = threads().doc(`${restaurantId}_${threadId}`);
    const snap = await ref.get();
    if (!snap.exists || snap.data().restaurantId !== String(restaurantId)) {
        const error = new Error('Conversation not found');
        error.status = 404;
        throw error;
    }
    const autoReply = enabled === true;
    await ref.set({ autoReply }, { merge: true });
    return { ...snap.data(), autoReply };
}

export async function replyOnThread(restaurantId, threadId, text) {
    const account = await getAccount(restaurantId);
    if (!account || account.status !== 'connected') {
        const error = new Error('Gmail is not connected.');
        error.status = 404;
        throw error;
    }
    const thread = await getThread(restaurantId, threadId);
    if (!thread) {
        const error = new Error('Conversation not found');
        error.status = 404;
        throw error;
    }
    const token = await accessTokenFor(account);
    await sendReply({
        account,
        token,
        to: thread.customerEmail,
        subject: thread.subject || 'Reservation',
        body: text,
        threadId,
        inReplyTo: thread.lastInboundId || '',
    });
    await threads().doc(`${restaurantId}_${threadId}`).set({ updatedAt: new Date().toISOString() }, { merge: true });
    return getThread(restaurantId, threadId);
}

async function sendReply({ account, token, to, subject, body, threadId, inReplyTo }) {
    const raw = encodeRawMessage({
        from: account.email,
        to,
        subject: subject.toLowerCase().startsWith('re:') ? subject : `Re: ${subject || 'Reservation'}`,
        body,
        inReplyTo,
        references: inReplyTo,
    });
    const sent = await gmailSend({ accessToken: token, raw, threadId });
    await messages().doc(sent.id || `out_${Date.now()}`).set({
        id: sent.id || null,
        restaurantId: account.restaurantId,
        threadId,
        from: account.email,
        to,
        subject,
        body,
        direction: 'outbound',
        at: new Date().toISOString(),
    });
    await bump(account, 'replies');
}

function baseThread(account, threadId, from, subject, existing) {
    return {
        id: `${account.restaurantId}_${threadId}`,
        restaurantId: account.restaurantId,
        threadId,
        customerEmail: addressFrom(from),
        customerName: existing.customerName || nameFrom(from),
        subject: subject || existing.subject || '',
        updatedAt: new Date().toISOString(),
    };
}

function nameFrom(from) {
    return guestNameFrom(from, '');
}

async function outboundAlreadyStored(restaurantId, threadId, body) {
    const snap = await messages().where('threadId', '==', threadId).limit(30).get();
    const text = String(body || '').replace(/\s+/g, ' ').trim();
    return snap.docs.some((doc) => {
        const row = doc.data();
        return row.restaurantId === String(restaurantId)
            && row.direction === 'outbound'
            && String(row.body || '').replace(/\s+/g, ' ').trim() === text;
    });
}

function addressFrom(from) {
    const match = String(from || '').match(/<([^>]+)>/);
    return (match ? match[1] : String(from || '')).trim();
}

async function bump(account, field) {
    const current = (await getAccount(account.restaurantId)) || account;
    await accounts().doc(account.restaurantId).set({ [field]: (current[field] || 0) + 1 }, { merge: true });
}

export async function listThreads(restaurantId) {
    const snap = await threads().where('restaurantId', '==', String(restaurantId)).limit(50).get();
    return snap.docs.map((doc) => doc.data()).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function getThread(restaurantId, threadId) {
    const doc = await threads().doc(`${restaurantId}_${threadId}`).get();
    if (!doc.exists || doc.data().restaurantId !== String(restaurantId)) return null;
    const snap = await messages().where('threadId', '==', threadId).limit(50).get();
    const seen = new Set();
    const items = snap.docs
        .map((row) => row.data())
        .filter((row) => row.restaurantId === String(restaurantId))
        .sort((a, b) => String(a.at).localeCompare(String(b.at)))
        .filter((row) => {
            const key = `${row.direction}|${String(row.body || '').replace(/\s+/g, ' ').trim()}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    return { ...doc.data(), messages: items };
}
