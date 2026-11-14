// Dashboard API for the booking WhatsApp inbox. Reads the inbox collections
// written by the existing webhook. It does not create a second WhatsApp channel.

import express from 'express';
import { db } from '../config/firebase.js';
import { getTenantById } from '../services/tenantService.js';
import whatsappClient from '../services/whatsapp/whatsappClient.js';
import { getWhatsAppConfig } from '../services/whatsapp/whatsappConfig.js';
import {
    INBOX_BACKFILL,
    conversationDocId,
    createFirestoreInboxStore,
    createInboxRecorder,
    customerWindowOpen,
    inboxContext,
    wrapWhatsAppClient,
} from '../services/whatsapp/whatsappInbox.js';
import { HOST_RESTAURANT_ID } from '../services/whatsapp/whatsappRestaurantDirectory.js';
import logger from '../utils/logger.js';

const router = express.Router();
const store = createFirestoreInboxStore(db);
const recorder = createInboxRecorder(store);
const client = wrapWhatsAppClient(whatsappClient, () => recorder);

function publicConversation(row) {
    return {
        id: row.id,
        customerName: row.name || 'WhatsApp guest',
        phone: row.phoneE164 || '',
        preview: row.lastMessage || '',
        lastMessageAt: row.lastMessageAt || null,
        unread: row.unread || 0,
        hasBooking: Boolean(row.hasBooking),
        status: row.hasBooking ? 'reservation_confirmed' : 'booking_requested',
        reservationStatus: row.hasBooking ? 'confirmed' : 'none',
        windowOpen: customerWindowOpen(row.lastCustomerMessageAt),
        bookings: row.bookings || [],
    };
}

function publicMessage(row) {
    return {
        id: row.id,
        from: row.direction === 'inbound' ? 'customer' : 'assistant',
        text: row.body || row.preview || '',
        type: row.type || 'text',
        status: row.status || null,
        createdAt: row.createdAt || null,
        mediaId: row.mediaId || null,
    };
}

async function scope(req, res) {
    const restaurantId = String(req.params.restaurantId || '').trim();
    if (!restaurantId || restaurantId === HOST_RESTAURANT_ID) {
        res.status(400).json({ error: 'restaurantId is required' });
        return null;
    }
    const tenant = await getTenantById(restaurantId);
    if (!tenant || tenant.isActive === false) {
        res.status(404).json({ error: 'Restaurant not found' });
        return null;
    }
    return { restaurantId, tenant };
}

router.get('/:restaurantId/conversations', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30));
        const booked = req.query.booked === 'true' ? true : req.query.booked === 'false' ? false : undefined;
        const result = await store.queryConversations({
            restaurantId: ctx.restaurantId,
            limit,
            cursor: req.query.cursor || undefined,
            unread: req.query.unread === 'true' ? true : undefined,
            booked,
            q: req.query.q || '',
        });
        res.json({
            conversations: result.conversations.map(publicConversation),
            nextCursor: result.nextCursor,
        });
    } catch (error) {
        logger.error(`❌ [WhatsApp Inbox] List failed: ${error.message}`);
        res.status(500).json({ error: 'Could not load conversations' });
    }
});

router.get('/:restaurantId/conversations/:conversationId', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        const row = await store.getConversation(req.params.conversationId);
        if (!row || row.restaurantId !== ctx.restaurantId) {
            res.status(404).json({ error: 'Conversation not found' });
            return;
        }
        res.json(publicConversation(row));
    } catch (error) {
        logger.error(`❌ [WhatsApp Inbox] Conversation failed: ${error.message}`);
        res.status(500).json({ error: 'Could not load the conversation' });
    }
});

router.get('/:restaurantId/conversations/:conversationId/messages', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        const row = await store.getConversation(req.params.conversationId);
        if (!row || row.restaurantId !== ctx.restaurantId) {
            res.status(404).json({ error: 'Conversation not found' });
            return;
        }
        const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30));
        const page = await store.listMessages(req.params.conversationId, {
            limit: limit + 1,
            before: req.query.before || undefined,
        });
        const hasMore = page.length > limit;
        const slice = page.slice(0, limit);
        res.json({
            messages: [...slice].reverse().map(publicMessage),
            nextBefore: hasMore ? slice[slice.length - 1]?.createdAt || null : null,
        });
    } catch (error) {
        logger.error(`❌ [WhatsApp Inbox] Messages failed: ${error.message}`);
        res.status(500).json({ error: 'Could not load messages' });
    }
});

router.get('/:restaurantId/conversations/:conversationId/bookings', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        const row = await store.getConversation(req.params.conversationId);
        if (!row || row.restaurantId !== ctx.restaurantId) {
            res.status(404).json({ error: 'Conversation not found' });
            return;
        }
        res.json({ bookings: row.bookings || [] });
    } catch (error) {
        logger.error(`❌ [WhatsApp Inbox] Bookings failed: ${error.message}`);
        res.status(500).json({ error: 'Could not load bookings' });
    }
});

router.post('/:restaurantId/conversations/:conversationId/read', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        const row = await store.getConversation(req.params.conversationId);
        if (!row || row.restaurantId !== ctx.restaurantId) {
            res.status(404).json({ error: 'Conversation not found' });
            return;
        }
        await store.saveConversation({ ...row, unread: 0, hasUnread: false, updatedAt: new Date().toISOString() });
        res.json({ unread: 0 });
    } catch (error) {
        logger.error(`❌ [WhatsApp Inbox] Read failed: ${error.message}`);
        res.status(500).json({ error: 'Could not update the conversation' });
    }
});

router.post('/:restaurantId/conversations/:conversationId/messages', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        const text = String(req.body?.text || '').trim();
        if (!text) {
            res.status(400).json({ error: 'Type a message first' });
            return;
        }
        const row = await store.getConversation(req.params.conversationId);
        if (!row || row.restaurantId !== ctx.restaurantId) {
            res.status(404).json({ error: 'Conversation not found' });
            return;
        }
        if (!customerWindowOpen(row.lastCustomerMessageAt)) {
            res.status(409).json({ error: 'The 24-hour WhatsApp window is closed. A template is required.' });
            return;
        }
        const { phoneId } = getWhatsAppConfig();
        const result = await inboxContext.run(
            { waId: row.waId, restaurantId: ctx.restaurantId, phoneNumberId: phoneId, profileName: row.name },
            () => client.sendText(row.waId, text),
        );
        if (!result?.ok) {
            res.status(502).json({ error: 'WhatsApp did not accept the message' });
            return;
        }
        res.json({ id: result.messageId, status: 'sent' });
    } catch (error) {
        logger.error(`❌ [WhatsApp Inbox] Send failed: ${error.message}`);
        res.status(500).json({ error: 'Could not send the message' });
    }
});

router.get('/:restaurantId/media/:mediaId', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        const conversation = await store.getConversation(req.query.conversationId || '');
        if (!conversation || conversation.restaurantId !== ctx.restaurantId) {
            res.status(404).json({ error: 'Conversation not found' });
            return;
        }
        const messages = await store.listMessages(conversation.id, { limit: 50 });
        const match = messages.find((row) => row.mediaId === req.params.mediaId);
        if (!match) {
            res.status(404).json({ error: 'Media not found' });
            return;
        }
        const { token, graphVersion } = getWhatsAppConfig();
        if (!token) {
            res.status(503).json({ error: 'WhatsApp is not configured' });
            return;
        }
        const meta = await fetch(`https://graph.facebook.com/${graphVersion}/${req.params.mediaId}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        const payload = await meta.json().catch(() => ({}));
        if (!meta.ok || !payload.url) {
            res.status(502).json({ error: 'WhatsApp media is unavailable' });
            return;
        }
        const file = await fetch(payload.url, { headers: { Authorization: `Bearer ${token}` } });
        if (!file.ok) {
            res.status(502).json({ error: 'WhatsApp media is unavailable' });
            return;
        }
        res.set('Content-Type', file.headers.get('content-type') || 'application/octet-stream');
        res.set('Cache-Control', 'private, max-age=300');
        res.send(Buffer.from(await file.arrayBuffer()));
    } catch (error) {
        logger.error(`❌ [WhatsApp Inbox] Media failed: ${error.message}`);
        res.status(500).json({ error: 'Could not load media' });
    }
});

router.post('/:restaurantId/repair', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        const flagRef = db.collection(INBOX_BACKFILL).doc(ctx.restaurantId);
        const flag = await flagRef.get();
        if (flag.exists) {
            res.json({ already: true, imported: flag.data()?.imported || 0 });
            return;
        }
        const { phoneId } = getWhatsAppConfig();
        const sessions = await db.collection('whatsappSessions').where('restaurantId', '==', ctx.restaurantId).limit(500).get();
        let imported = 0;
        for (const doc of sessions.docs) {
            const session = doc.data() || {};
            const history = Array.isArray(session.history) ? session.history : [];
            for (let index = 0; index < history.length; index += 1) {
                const item = history[index];
                const wamid = `legacy_${doc.id}_${index}_${item?.role || 'note'}`;
                const payload = {
                    phoneNumberId: phoneId,
                    restaurantId: ctx.restaurantId,
                    waId: doc.id,
                    wamid,
                    body: item?.content || '',
                    type: 'text',
                    name: session.data?.name || null,
                };
                const saved = item?.role === 'assistant'
                    ? await recorder.recordOutbound(payload)
                    : await recorder.recordInbound(payload);
                if (saved && !saved.duplicate) imported += 1;
            }
            if (session.lastBooking?.paymentId) {
                await recorder.attachBooking({
                    phoneNumberId: phoneId,
                    restaurantId: ctx.restaurantId,
                    waId: doc.id,
                    name: session.data?.name,
                    booking: session.lastBooking,
                });
            }
        }
        await flagRef.set({ restaurantId: ctx.restaurantId, imported, at: new Date().toISOString() });
        res.json({ already: false, imported });
    } catch (error) {
        logger.error(`❌ [WhatsApp Inbox] Repair failed: ${error.message}`);
        res.status(500).json({ error: 'Could not restore older chats' });
    }
});

export { conversationDocId };
export default router;
