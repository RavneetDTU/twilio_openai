// Staff inbox for WhatsApp booking chats. Additive collections only.
// The booking agent, session store, and marketing inbox are unchanged.
// A missing inbox write must never block a send or a webhook.

import { AsyncLocalStorage } from 'node:async_hooks';
import logger from '../../utils/logger.js';
import { HOST_RESTAURANT_ID } from './whatsappRestaurantDirectory.js';

export const INBOX_CONVERSATIONS = 'whatsappInboxConversations';
export const INBOX_MESSAGES = 'whatsappInboxMessages';
export const INBOX_BACKFILL = 'whatsappInboxBackfill';

export const inboxContext = new AsyncLocalStorage();

const WINDOW_MS = 24 * 60 * 60 * 1000;
const STATUS_RANK = { sent: 1, delivered: 2, read: 3, failed: 1 };

export function conversationDocId(phoneNumberId, restaurantId, waId) {
    return `${phoneNumberId || 'wa'}_${restaurantId || HOST_RESTAURANT_ID}_${String(waId || '').replace(/\D/g, '')}`;
}

export function mergeDeliveryStatus(current, incoming) {
    const next = String(incoming || '').toLowerCase();
    const prev = String(current || 'sent').toLowerCase();
    if (!next) return prev;
    if (next === 'failed' && (prev === 'delivered' || prev === 'read')) return prev;
    if ((STATUS_RANK[next] || 0) >= (STATUS_RANK[prev] || 0)) return next;
    return prev;
}

function clip(text, max = 160) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function messagePreview(type, body) {
    if (body) return clip(body);
    if (type === 'image') return 'Photo';
    if (type === 'audio' || type === 'voice') return 'Voice message';
    if (type === 'video') return 'Video';
    if (type === 'document') return 'Document';
    if (type === 'location') return 'Location';
    if (type === 'sticker') return 'Sticker';
    return 'Message';
}

function digits(value) {
    return String(value || '').replace(/\D/g, '');
}

export function customerWindowOpen(lastCustomerMessageAt, now = Date.now()) {
    const at = Date.parse(lastCustomerMessageAt || '');
    return Number.isFinite(at) && now - at < WINDOW_MS;
}

function blankConversation({ id, phoneNumberId, restaurantId, waId, name, at }) {
    return {
        id,
        phoneNumberId: phoneNumberId || 'wa',
        restaurantId: String(restaurantId || HOST_RESTAURANT_ID),
        waId: digits(waId),
        phoneE164: `+${digits(waId)}`,
        name: name || 'WhatsApp guest',
        nameLower: String(name || 'whatsapp guest').toLowerCase(),
        lastMessage: '',
        lastMessageAt: at,
        lastMessageDirection: null,
        lastCustomerMessageAt: null,
        unread: 0,
        hasUnread: false,
        hasBooking: false,
        bookings: [],
        promotedFromHost: false,
        createdAt: at,
        updatedAt: at,
    };
}

function applySummary(conversation, message, { inbound, name }) {
    const next = { ...conversation, bookings: [...(conversation.bookings || [])] };
    if (name && (next.name === 'WhatsApp guest' || !next.name)) {
        next.name = name;
        next.nameLower = name.toLowerCase();
    }
    next.lastMessage = message.preview;
    next.lastMessageAt = message.createdAt;
    next.lastMessageDirection = message.direction;
    next.updatedAt = message.createdAt;
    if (inbound) {
        next.lastCustomerMessageAt = message.createdAt;
        next.unread = (next.unread || 0) + 1;
        next.hasUnread = true;
    }
    return next;
}

export function createMemoryInboxStore() {
    const conversations = new Map();
    const messages = new Map();

    function remember(message, { name } = {}) {
        if (!message?.id || messages.has(message.id)) return { duplicate: true };
        messages.set(message.id, { ...message });
        const current = conversations.get(message.conversationId) || blankConversation({
            id: message.conversationId,
            phoneNumberId: message.phoneNumberId,
            restaurantId: message.restaurantId,
            waId: message.waId,
            name,
            at: message.createdAt,
        });
        conversations.set(message.conversationId, applySummary(current, message, { inbound: message.direction === 'inbound', name }));
        return { duplicate: false };
    }

    return {
        conversations,
        messages,
        async recordMessage(message, extra) {
            return remember(message, extra);
        },
        async getConversation(id) {
            const row = conversations.get(id);
            return row ? { ...row, bookings: [...(row.bookings || [])] } : null;
        },
        async saveConversation(row) {
            conversations.set(row.id, { ...row, bookings: [...(row.bookings || [])] });
        },
        async listMessages(conversationId) {
            return [...messages.values()]
                .filter((row) => row.conversationId === conversationId)
                .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        },
        async moveMessage(id, conversationId, restaurantId) {
            const current = messages.get(id);
            if (!current || current.conversationId === conversationId) return false;
            messages.set(id, { ...current, conversationId, restaurantId });
            return true;
        },
        async updateStatus(id, incoming) {
            const current = messages.get(id);
            if (!current) return false;
            const merged = mergeDeliveryStatus(current.status, incoming);
            if (merged === current.status) return false;
            messages.set(id, { ...current, status: merged });
            return true;
        },
        async queryConversations({ restaurantId, limit = 30, cursor, unread, booked, q }) {
            let rows = [...conversations.values()].filter((row) => row.restaurantId === String(restaurantId) && row.restaurantId !== HOST_RESTAURANT_ID);
            if (unread === true) rows = rows.filter((row) => row.hasUnread);
            if (booked === true) rows = rows.filter((row) => row.hasBooking);
            if (booked === false) rows = rows.filter((row) => !row.hasBooking);
            const needle = String(q || '').trim().toLowerCase();
            if (needle) {
                const phone = digits(needle);
                rows = rows.filter((row) => row.nameLower.startsWith(needle) || (phone && row.waId.startsWith(phone)));
            }
            rows.sort((a, b) => String(b.lastMessageAt).localeCompare(String(a.lastMessageAt)));
            if (cursor) rows = rows.filter((row) => String(row.lastMessageAt) < String(cursor));
            const page = rows.slice(0, limit);
            return { conversations: page.map((row) => ({ ...row, bookings: [...(row.bookings || [])] })), nextCursor: rows.length > limit ? page[page.length - 1]?.lastMessageAt || null : null };
        },
    };
}

function firestoreAlreadyExists(error) {
    return error?.code === 6 || /ALREADY_EXISTS/i.test(error?.message || '');
}

export function createFirestoreInboxStore(db) {
    const conversations = () => db.collection(INBOX_CONVERSATIONS);
    const messages = () => db.collection(INBOX_MESSAGES);

    return {
        async recordMessage(message) {
            try {
                await messages().doc(message.id).create(message);
            } catch (error) {
                if (firestoreAlreadyExists(error)) return { duplicate: true };
                throw error;
            }
            const ref = conversations().doc(message.conversationId);
            await db.runTransaction(async (tx) => {
                const snap = await tx.get(ref);
                const current = snap.exists
                    ? snap.data()
                    : blankConversation({
                        id: message.conversationId,
                        phoneNumberId: message.phoneNumberId,
                        restaurantId: message.restaurantId,
                        waId: message.waId,
                        name: message.name,
                        at: message.createdAt,
                    });
                tx.set(ref, applySummary({ ...current, id: message.conversationId }, message, {
                    inbound: message.direction === 'inbound',
                    name: message.name,
                }));
            });
            return { duplicate: false };
        },
        async getConversation(id) {
            const snap = await conversations().doc(id).get();
            return snap.exists ? { id: snap.id, ...snap.data() } : null;
        },
        async saveConversation(row) {
            await conversations().doc(row.id).set(row);
        },
        async listMessages(conversationId, { limit = 30, before } = {}) {
            const newestFirst = (rows) => rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
            try {
                let query = messages()
                    .where('conversationId', '==', conversationId)
                    .orderBy('createdAt', 'desc');
                if (before) query = query.startAfter(before);
                if (limit) query = query.limit(limit);
                const snap = await query.get();
                return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
            } catch (error) {
                if (!/requires an index/i.test(error?.message || '')) throw error;
                const snap = await messages().where('conversationId', '==', conversationId).get();
                let rows = newestFirst(snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
                if (before) {
                    const index = rows.findIndex((row) => row.createdAt === before);
                    rows = index >= 0 ? rows.slice(index + 1) : rows.filter((row) => String(row.createdAt || '') < String(before));
                }
                return limit ? rows.slice(0, limit) : rows;
            }
        },
        async moveMessage(id, conversationId, restaurantId) {
            const ref = messages().doc(id);
            const snap = await ref.get();
            if (!snap.exists || snap.data().conversationId === conversationId) return false;
            await ref.update({ conversationId, restaurantId });
            return true;
        },
        async updateStatus(id, incoming) {
            const ref = messages().doc(id);
            const snap = await ref.get();
            if (!snap.exists) return false;
            const merged = mergeDeliveryStatus(snap.data().status, incoming);
            if (merged === snap.data().status) return false;
            await ref.update({ status: merged });
            return true;
        },
        async queryConversations({ restaurantId, limit = 30, cursor, unread, booked, q }) {
            const equalities = [['restaurantId', '==', String(restaurantId)]];
            if (unread === true) equalities.push(['hasUnread', '==', true]);
            if (booked === true) equalities.push(['hasBooking', '==', true]);
            if (booked === false) equalities.push(['hasBooking', '==', false]);
            const needle = String(q || '').trim().toLowerCase();
            const phone = digits(needle);
            const orderField = phone && phone.length >= 6 ? 'waId' : needle ? 'nameLower' : 'lastMessageAt';
            const direction = orderField === 'lastMessageAt' ? 'desc' : 'asc';
            const filters = [...equalities];
            if (orderField === 'waId') filters.push(['waId', '>=', phone], ['waId', '<=', `${phone}\uf8ff`]);
            else if (orderField === 'nameLower') filters.push(['nameLower', '>=', needle], ['nameLower', '<=', `${needle}\uf8ff`]);

            const page = (rows) => {
                let list = rows;
                if (orderField === 'waId') list = list.filter((row) => String(row.waId || '').startsWith(phone));
                else if (orderField === 'nameLower') list = list.filter((row) => String(row.nameLower || '').startsWith(needle));
                list.sort((a, b) => {
                    const cmp = String(a[orderField] || '').localeCompare(String(b[orderField] || ''));
                    return direction === 'desc' ? -cmp : cmp;
                });
                if (cursor && orderField === 'lastMessageAt') {
                    const index = list.findIndex((row) => row.lastMessageAt === cursor);
                    list = index >= 0 ? list.slice(index + 1) : list.filter((row) => String(row.lastMessageAt || '') < String(cursor));
                }
                const slice = list.slice(0, limit);
                return {
                    conversations: slice,
                    nextCursor: slice.length === limit ? slice[slice.length - 1]?.lastMessageAt || null : null,
                };
            };

            try {
                let query = conversations();
                for (const [field, op, value] of filters) query = query.where(field, op, value);
                query = query.orderBy(orderField, direction).limit(limit);
                if (cursor && orderField === 'lastMessageAt') query = query.startAfter(cursor);
                const snap = await query.get();
                const rows = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
                return { conversations: rows, nextCursor: rows.length === limit ? rows[rows.length - 1]?.lastMessageAt || null : null };
            } catch (error) {
                if (!/requires an index/i.test(error?.message || '')) throw error;
                let query = conversations();
                for (const [field, op, value] of equalities) query = query.where(field, op, value);
                const snap = await query.get();
                return page(snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
            }
        },
    };
}

function buildMessage({ phoneNumberId, restaurantId, waId, wamid, direction, body, type, status, createdAt, mediaId, name }) {
    const at = createdAt || new Date().toISOString();
    const kind = type || 'text';
    return {
        id: wamid,
        conversationId: conversationDocId(phoneNumberId, restaurantId, waId),
        phoneNumberId: phoneNumberId || 'wa',
        restaurantId: String(restaurantId || HOST_RESTAURANT_ID),
        waId: digits(waId),
        direction,
        type: kind,
        body: body || '',
        preview: messagePreview(kind, body),
        status: status || (direction === 'inbound' ? 'received' : 'sent'),
        mediaId: mediaId || null,
        name: name || null,
        createdAt: at,
    };
}

export function createInboxRecorder(store, { phoneNumberId } = {}) {
    async function safe(work) {
        try {
            return await work();
        } catch (error) {
            logger.error(`❌ [WhatsApp Inbox] ${error.message}`);
            return null;
        }
    }

    async function promoteHostThread(message) {
        if (!message || message.restaurantId === HOST_RESTAURANT_ID) return;
        const conversation = await store.getConversation(message.conversationId);
        if (!conversation || conversation.promotedFromHost) return;
        const hostId = conversationDocId(message.phoneNumberId, HOST_RESTAURANT_ID, message.waId);
        const older = await store.listMessages(hostId, { limit: 40 });
        for (const row of older) {
            await store.moveMessage(row.id, message.conversationId, message.restaurantId);
        }
        const fresh = await store.getConversation(message.conversationId);
        if (fresh) await store.saveConversation({ ...fresh, promotedFromHost: true });
    }

    return {
        async recordInbound(input) {
            return safe(async () => {
                const message = buildMessage({
                    phoneNumberId: input.phoneNumberId || phoneNumberId,
                    restaurantId: input.restaurantId,
                    waId: input.waId,
                    wamid: input.wamid,
                    direction: 'inbound',
                    body: input.body,
                    type: input.type,
                    status: 'received',
                    createdAt: input.createdAt,
                    mediaId: input.mediaId,
                    name: input.name,
                });
                const saved = await store.recordMessage(message);
                if (!saved?.duplicate) await promoteHostThread(message);
                return saved;
            });
        },
        async recordOutbound(input) {
            return safe(async () => {
                const message = buildMessage({
                    phoneNumberId: input.phoneNumberId || phoneNumberId,
                    restaurantId: input.restaurantId,
                    waId: input.waId,
                    wamid: input.wamid,
                    direction: 'outbound',
                    body: input.body,
                    type: input.type || 'text',
                    status: 'sent',
                    createdAt: input.createdAt,
                    name: input.name,
                });
                const saved = await store.recordMessage(message);
                if (!saved?.duplicate) await promoteHostThread(message);
                return saved;
            });
        },
        async applyStatuses(statuses = []) {
            return safe(async () => {
                let updated = 0;
                for (const status of statuses) {
                    if (!status?.id) continue;
                    if (await store.updateStatus(status.id, status.status)) updated += 1;
                }
                return updated;
            });
        },
        async attachBooking(input) {
            return safe(async () => {
                const id = conversationDocId(input.phoneNumberId || phoneNumberId, input.restaurantId, input.waId);
                const now = new Date().toISOString();
                const current = await store.getConversation(id) || blankConversation({
                    id,
                    phoneNumberId: input.phoneNumberId || phoneNumberId,
                    restaurantId: input.restaurantId,
                    waId: input.waId,
                    name: input.name,
                    at: now,
                });
                const booking = {
                    paymentId: input.booking.paymentId,
                    date: input.booking.date || null,
                    time: input.booking.time || null,
                    guests: input.booking.guests ?? null,
                    name: input.booking.name || input.name || current.name,
                    status: input.booking.status || 'booked',
                    paymentStatus: input.booking.paymentStatus || null,
                    bookingAmount: input.booking.bookingAmount ?? null,
                    createdAt: now,
                };
                const bookings = [booking, ...(current.bookings || []).filter((row) => row.paymentId !== booking.paymentId)].slice(0, 20);
                const next = {
                    ...current,
                    name: input.name || current.name,
                    nameLower: String(input.name || current.name || '').toLowerCase(),
                    hasBooking: true,
                    bookings,
                    updatedAt: now,
                };
                await store.saveConversation(next);
                return next;
            });
        },
    };
}

export function wrapWhatsAppClient(client, getRecorder) {
    async function recorded(method, to, body, type, send) {
        const result = await send();
        const ctx = inboxContext.getStore();
        if (result?.ok && result.messageId && ctx) {
            const recorder = getRecorder();
            if (recorder) {
                await recorder.recordOutbound({
                    phoneNumberId: ctx.phoneNumberId,
                    restaurantId: ctx.restaurantId,
                    waId: ctx.waId || to,
                    wamid: result.messageId,
                    body,
                    type,
                    name: ctx.profileName,
                });
            }
        }
        return result;
    }

    return {
        ...client,
        sendText: (to, body) => recorded('text', to, body, 'text', () => client.sendText(to, body)),
        sendButtons: (to, body, buttons) => recorded('buttons', to, body, 'interactive', () => client.sendButtons(to, body, buttons)),
        sendList: (to, body, buttonText, rows, sectionTitle) => recorded('list', to, body, 'interactive', () => client.sendList(to, body, buttonText, rows, sectionTitle)),
        sendTemplate: (to, name, params, languageCode) => recorded('template', to, name, 'template', () => client.sendTemplate(to, name, params, languageCode)),
        sendTemplateMessage: (to, payload) => recorded('template', to, payload?.name, 'template', () => client.sendTemplateMessage(to, payload)),
        markRead: (...args) => client.markRead(...args),
    };
}

export function inboundBody(message, input) {
    if (input?.type === 'text') return input.text || '';
    if (input?.type === 'reply') return input.title || input.id || '';
    if (message?.type === 'image') return message.image?.caption || '';
    if (message?.type === 'video') return message.video?.caption || '';
    if (message?.type === 'document') return message.document?.caption || message.document?.filename || '';
    if (message?.location) return [message.location.latitude, message.location.longitude].filter((value) => value != null).join(', ');
    return '';
}

export function inboundMediaId(message) {
    return message?.image?.id || message?.audio?.id || message?.video?.id || message?.document?.id || message?.sticker?.id || null;
}
