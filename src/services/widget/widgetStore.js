// Website widget conversations. Additive collection only.
// A chat and a call each keep their own session id.

import logger from '../../utils/logger.js';

export const WIDGET_CONVERSATIONS = 'widgetConversations';

const PAGE_MAX = 50;

export function cleanSessionId(value) {
    const id = String(value || '').trim();
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) return '';
    return id;
}

export function cleanRestaurantId(value) {
    const id = String(value || '').trim();
    if (!id || id.length > 64) return '';
    return id;
}

export function transcriptLine(from, text) {
    const body = String(text || '').trim().slice(0, 2000);
    if (!body) return '';
    return from === 'visitor' ? `👤 Guest: ${body}` : `🤖 Agent: ${body}`;
}

export function parseTranscript(transcript) {
    return (Array.isArray(transcript) ? transcript : [])
        .map((line, index) => {
            const raw = String(line || '').trim();
            if (!raw) return null;
            const visitor = raw.startsWith('👤') || /^guest:/i.test(raw);
            const text = raw
                .replace(/^👤\s*/u, '')
                .replace(/^🤖\s*/u, '')
                .replace(/^guest:\s*/i, '')
                .replace(/^agent:\s*/i, '')
                .trim();
            if (!text) return null;
            return { id: String(index), index, from: visitor ? 'visitor' : 'assistant', text };
        })
        .filter(Boolean);
}

export function pageTranscript(transcript, { limit = 30, before = null } = {}) {
    const size = Math.min(PAGE_MAX, Math.max(1, Number(limit) || 30));
    const messages = parseTranscript(transcript);
    const end = before == null || before === ''
        ? messages.length
        : messages.findIndex((item) => item.index === Number(before));
    const sliceEnd = end < 0 ? messages.length : end;
    const start = Math.max(0, sliceEnd - size);
    const page = messages.slice(start, sliceEnd);
    return { messages: page, nextBefore: start > 0 ? page[0]?.index ?? null : null };
}

export function summaryOf(row) {
    const booking = row.booking || row.bookingData || null;
    const calls = Array.isArray(row.calls) ? row.calls : [];
    const latestCall = calls[calls.length - 1] || null;
    const kinds = new Set((row.events || []).map((event) => event.kind || 'chat'));
    const hasVoice = kinds.has('voice') || kinds.has('call') || calls.length > 0 || row.channel === 'voice';
    const hasChat = kinds.has('chat') || (row.transcript || []).length > 0;
    const channel = hasVoice && hasChat ? 'both' : (hasVoice ? 'voice' : 'chat');
    return {
        sessionId: row.sessionId,
        restaurantId: row.restaurantId,
        restaurantName: row.restaurantName || booking?.restaurantName || '',
        conversationType: booking ? 'reservation' : (row.conversationType || 'other'),
        channel,
        hasVoice,
        status: row.status || 'open',
        callStatus: latestCall?.status || row.callStatus || null,
        capturedAt: row.capturedAt || null,
        startedAt: row.startedAt || row.capturedAt || null,
        websiteDomain: row.websiteDomain || '',
        preview: row.preview || '',
        guestName: row.guestName || booking?.name || null,
        phone: row.phone || booking?.phone || null,
        relatedSessionId: row.relatedSessionId || null,
        unread: row.unread || 0,
        hasBooking: Boolean(booking?.paymentId),
        booking: booking?.paymentId ? {
            paymentId: booking.paymentId,
            restaurantName: booking.restaurantName || row.restaurantName || '',
            name: booking.name || null,
            guests: booking.guests || null,
            date: booking.date || null,
            time: booking.time || null,
            status: booking.status || 'booked',
            paymentLink: booking.paymentLink || null,
        } : null,
        transcriptStatus: !hasVoice
            ? 'ready'
            : ((row.events || []).some((event) => event.kind === 'voice') || (row.transcript || []).length
                ? 'ready'
                : (latestCall?.status === 'active' || latestCall?.status === 'connecting' ? 'processing' : 'unavailable')),
    };
}

export function pageEvents(events, { limit = 30, before = null } = {}) {
    const size = Math.min(PAGE_MAX, Math.max(1, Number(limit) || 30));
    const messages = (Array.isArray(events) ? events : []).map((event, index) => ({
        id: event.id || String(index),
        index,
        at: event.at || null,
        from: event.from === 'visitor' ? 'visitor' : (event.from === 'system' ? 'system' : 'assistant'),
        text: String(event.text || ''),
        kind: event.kind || 'chat',
        callId: event.callId || null,
    })).filter((event) => event.text);
    const end = before == null || before === ''
        ? messages.length
        : messages.findIndex((item) => item.index === Number(before));
    const sliceEnd = end < 0 ? messages.length : end;
    const start = Math.max(0, sliceEnd - size);
    const page = messages.slice(start, sliceEnd);
    return { messages: page, nextBefore: start > 0 ? page[0]?.index ?? null : null };
}

function previewFrom(transcript) {
    const messages = parseTranscript(transcript);
    const last = messages[messages.length - 1];
    return last ? last.text.slice(0, 160) : '';
}

export function createWidgetStore(db) {
    const col = () => db.collection(WIDGET_CONVERSATIONS);

    async function saveConversation(input) {
        const sessionId = cleanSessionId(input.sessionId);
        const restaurantId = cleanRestaurantId(input.restaurantId);
        if (!sessionId || !restaurantId) {
            const error = new Error('sessionId and restaurantId are required');
            error.status = 400;
            throw error;
        }
        const ref = col().doc(sessionId);
        const existingSnap = await ref.get();
        const existing = existingSnap.exists ? existingSnap.data() : null;
        if (existing && existing.restaurantId !== restaurantId && !input.trusted) {
            const error = new Error('Conversation not found');
            error.status = 404;
            throw error;
        }
        const now = new Date().toISOString();
        const transcript = Array.isArray(input.transcript)
            ? input.transcript.map((line) => String(line || '').slice(0, 2000)).filter(Boolean).slice(-200)
            : (existing?.transcript || []);
        let events = Array.isArray(existing?.events) ? existing.events : [];
        if (Array.isArray(input.events)) events = input.events;
        if (Array.isArray(input.appendEvents)) {
            events = [...events, ...input.appendEvents].slice(-400);
        }
        events = events
            .filter((event) => event && String(event.text || '').trim())
            .map((event) => ({
                id: String(event.id || '').slice(0, 80),
                at: event.at || now,
                from: event.from === 'visitor' ? 'visitor' : (event.from === 'system' ? 'system' : 'assistant'),
                text: String(event.text).slice(0, 2000),
                kind: event.kind === 'voice' || event.kind === 'call' ? event.kind : 'chat',
                callId: event.callId ? String(event.callId).slice(0, 80) : null,
            }));
        let calls = Array.isArray(existing?.calls) ? existing.calls : [];
        if (input.call && input.call.id) {
            const call = {
                id: String(input.call.id).slice(0, 80),
                status: String(input.call.status || 'connecting').slice(0, 40),
                startedAt: input.call.startedAt || existing?.calls?.find((item) => item.id === input.call.id)?.startedAt || now,
                endedAt: input.call.endedAt || null,
            };
            calls = [...calls.filter((item) => item.id !== call.id), call].slice(-20);
        }
        const hasVoiceEvents = events.some((event) => event.kind === 'voice' || event.kind === 'call') || calls.length > 0;
        const hasChatEvents = events.some((event) => event.kind === 'chat') || transcript.length > 0;
        const channel = hasVoiceEvents && hasChatEvents ? 'both' : (hasVoiceEvents ? 'voice' : 'chat');
        const lastEvent = events[events.length - 1];
        const guestName = input.trusted ? (input.guestName || existing?.guestName || null) : (existing?.guestName || null);
        const booking = input.trusted ? (input.booking || existing?.booking || null) : (existing?.booking || null);
        const previousIds = new Set((existing?.events || []).map((event) => event.id));
        const addedVisitor = events.some((event) => event.from === 'visitor' && event.id && !previousIds.has(event.id));
        const row = {
            sessionId,
            restaurantId: input.trusted && input.restaurantId ? restaurantId : (existing?.restaurantId || restaurantId),
            restaurantName: input.trusted ? (input.restaurantName || existing?.restaurantName || '') : (existing?.restaurantName || ''),
            channel,
            status: existing?.status === 'completed' || booking?.paymentId ? 'completed' : 'open',
            conversationType: booking?.paymentId ? 'reservation' : (existing?.conversationType || 'other'),
            transcript,
            events,
            calls,
            preview: (lastEvent?.text || previewFrom(transcript) || '').slice(0, 160),
            websiteDomain: input.websiteDomain || existing?.websiteDomain || '',
            startedAt: existing?.startedAt || now,
            capturedAt: input.markRead ? (existing?.capturedAt || now) : now,
            guestName,
            phone: input.trusted ? (input.phone || existing?.phone || null) : (existing?.phone || null),
            callStatus: input.call?.status || input.callStatus || existing?.callStatus || null,
            visitorKey: existing?.visitorKey || input.visitorKey || null,
            agent: input.trusted ? (input.agent || existing?.agent || null) : (existing?.agent || null),
            booking,
            bookingData: booking,
            unread: input.markRead ? 0 : ((existing?.unread || 0) + (addedVisitor ? 1 : 0)),
            managerMessage: existing?.managerMessage || null,
        };
        await ref.set(row, { merge: true });
        return row;
    }

    async function getConversation(restaurantId, sessionId) {
        const id = cleanSessionId(sessionId);
        const tenant = cleanRestaurantId(restaurantId);
        if (!id || !tenant) return null;
        const snap = await col().doc(id).get();
        if (!snap.exists) return null;
        const row = snap.data();
        if (row.restaurantId !== tenant) return null;
        return row;
    }

    async function listConversations(restaurantId, { limit = 30, cursor = '', kind = '', status = '' } = {}) {
        const pageSize = Math.min(PAGE_MAX, Math.max(1, Number(limit) || 30));
        const filters = [['restaurantId', '==', restaurantId]];
        if (kind === 'chat' || kind === 'voice') filters.push(['channel', 'in', kind === 'voice' ? ['voice', 'both'] : ['chat', 'both']]);
        if (status === 'open' || status === 'completed') filters.push(['status', '==', status]);

        const toPage = (rows) => {
            const sorted = rows.sort((a, b) => String(b.capturedAt || '').localeCompare(String(a.capturedAt || '')));
            const start = cursor ? Math.max(0, sorted.findIndex((row) => row.capturedAt === cursor) + 1) : 0;
            const slice = sorted.slice(start, start + pageSize + 1);
            const hasMore = slice.length > pageSize;
            const page = (hasMore ? slice.slice(0, pageSize) : slice).map(summaryOf);
            return { data: page, nextCursor: hasMore ? page[page.length - 1]?.capturedAt || null : null };
        };

        try {
            let query = col();
            for (const [field, op, value] of filters) query = query.where(field, op, value);
            query = query.orderBy('capturedAt', 'desc').limit(pageSize + 1);
            if (cursor) query = query.startAfter(cursor);
            const snap = await query.get();
            const docs = snap.docs.map((doc) => doc.data());
            const hasMore = docs.length > pageSize;
            const page = (hasMore ? docs.slice(0, pageSize) : docs).map(summaryOf);
            return { data: page, nextCursor: hasMore ? page[page.length - 1]?.capturedAt || null : null };
        } catch (error) {
            if (!/requires an index/i.test(error?.message || '')) throw error;
            logger.warn('Widget conversation list is sorting this restaurant in memory until the capturedAt index exists.');
            let query = col().where('restaurantId', '==', restaurantId);
            const snap = await query.get();
            let rows = snap.docs.map((doc) => doc.data());
            if (kind === 'voice') rows = rows.filter((row) => row.channel === 'voice' || row.channel === 'both');
            if (kind === 'chat') rows = rows.filter((row) => row.channel === 'chat' || row.channel === 'both');
            if (status === 'open' || status === 'completed') rows = rows.filter((row) => (row.status || 'open') === status);
            return toPage(rows);
        }
    }

    return { saveConversation, getConversation, listConversations };
}
