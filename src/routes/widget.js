// Public website widget. Chat, browser voice, and the dashboard inbox.
// Does not handle Twilio calls or the SIP trunk.

import express from 'express';
import { db } from '../config/firebase.js';
import { getTenantById } from '../services/tenantService.js';
import { createRealtimeSecret } from '../services/widget/widgetChat.js';
import {
    buildWidgetPrompt,
    detailsFromGuestLines,
    handleWidgetTurn,
    realtimeTools,
    runWidgetTool,
    welcomeMessage,
} from '../services/widget/widgetAgent.js';
import {
    cleanRestaurantId,
    cleanSessionId,
    createWidgetStore,
    pageEvents,
    pageTranscript,
    summaryOf,
} from '../services/widget/widgetStore.js';
import logger from '../utils/logger.js';

const router = express.Router();
const store = createWidgetStore(db);
const hits = new Map();

function tooMany(ip) {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((time) => now - time < 60_000);
    recent.push(now);
    hits.set(ip, recent);
    return recent.length > 40;
}

function clientError(res, error) {
    const status = error.status || 500;
    if (status >= 500) logger.error(`Widget API error: ${error.message}`);
    return res.status(status).json({ error: status >= 500 ? 'The widget could not complete that request.' : error.message });
}

function eventId() {
    return `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function ownedConversation(sessionId, visitorKey) {
    const snap = await db.collection('widgetConversations').doc(sessionId).get();
    if (!snap.exists) return null;
    const row = snap.data();
    if (!visitorKey || row.visitorKey !== visitorKey) return null;
    return row;
}

router.post('/chat', async (req, res) => {
    try {
        if (tooMany(req.ip || 'unknown')) return res.status(429).json({ error: 'Too many messages. Please wait a moment.' });
        const sessionId = cleanSessionId(req.body?.sessionId);
        const visitorKey = cleanSessionId(req.body?.visitorKey);
        if (!sessionId || !visitorKey) return res.status(400).json({ error: 'sessionId and visitorKey are required' });
        const existing = await ownedConversation(sessionId, visitorKey);
        const websiteDomain = String(req.body?.websiteDomain || '').slice(0, 120);
        if (req.body?.kickoff === true && !existing) {
            const welcome = welcomeMessage();
            const saved = await store.saveConversation({
                sessionId,
                restaurantId: 'public',
                visitorKey,
                channel: 'chat',
                trusted: true,
                websiteDomain,
                events: [{ id: eventId(), at: new Date().toISOString(), from: 'assistant', text: welcome, kind: 'chat' }],
                agent: {},
            });
            return res.json({ message: { role: 'assistant', content: welcome }, sessionId: saved.sessionId, restaurantName: '' });
        }
        if (!existing) return res.status(404).json({ error: 'Conversation not found' });
        const text = String(req.body?.text || '').trim().slice(0, 2000);
        if (!text) return res.status(400).json({ error: 'A message is required' });
        const turn = await handleWidgetTurn({
            apiKey: process.env.OPENAI_API_KEY,
            state: existing.agent || {},
            events: existing.events || [],
            text,
            sessionId,
        });
        const now = new Date().toISOString();
        const restaurantId = turn.state.restaurantId || existing.restaurantId || 'public';
        const saved = await store.saveConversation({
            sessionId,
            restaurantId,
            visitorKey,
            channel: 'chat',
            trusted: true,
            restaurantName: turn.state.restaurantName || '',
            guestName: turn.state.guestName || null,
            phone: turn.state.phone || turn.state.booking?.phone || null,
            booking: turn.state.booking || null,
            agent: turn.state,
            websiteDomain,
            appendEvents: [
                { id: eventId(), at: now, from: 'visitor', text, kind: 'chat' },
                { id: eventId(), at: now, from: 'assistant', text: turn.reply, kind: 'chat' },
            ],
        });
        return res.json({
            message: { role: 'assistant', content: turn.reply },
            sessionId: saved.sessionId,
            restaurantId: saved.restaurantId === 'public' ? null : saved.restaurantId,
            restaurantName: saved.restaurantName || '',
            guestName: saved.guestName || null,
        });
    } catch (error) {
        return clientError(res, error);
    }
});

router.get('/session', async (req, res) => {
    try {
        if (tooMany(req.ip || 'unknown')) return res.status(429).json({ error: 'Too many call attempts. Please wait a moment.' });
        const sessionId = cleanSessionId(req.query.sessionId);
        const visitorKey = cleanSessionId(req.query.visitorKey);
        const existing = await ownedConversation(sessionId, visitorKey);
        if (!existing) return res.status(404).json({ error: 'Conversation not found' });
        const model = process.env.WIDGET_REALTIME_MODEL || 'gpt-realtime';
        const secret = await createRealtimeSecret({
            apiKey: process.env.OPENAI_API_KEY,
            instructions: `${buildWidgetPrompt(existing.agent || {})}\n\nThe guest is speaking on a website call. Do not greet. A separate step speaks the greeting once. Use the tools for restaurants, availability and booking. Speak only English.`,
            tools: realtimeTools(),
            model,
        });
        return res.json({ ...secret, greeting: welcomeMessage() });
    } catch (error) {
        return clientError(res, error);
    }
});

router.post('/place', async (req, res) => {
    try {
        const sessionId = cleanSessionId(req.body?.sessionId);
        const visitorKey = cleanSessionId(req.body?.visitorKey);
        const existing = await ownedConversation(sessionId, visitorKey);
        if (!existing) return res.status(404).json({ error: 'Conversation not found' });
        const latitude = Number(req.body?.latitude);
        const longitude = Number(req.body?.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return res.status(400).json({ error: 'A location is required' });
        let area = '';
        try {
            const response = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`);
            if (response.ok) {
                const place = await response.json();
                const locality = place.locality || '';
                const city = place.city && place.city !== locality ? place.city : '';
                area = [locality, city].filter(Boolean).join(', ');
            }
        } catch (error) {
            logger.warn(`Widget location lookup failed: ${error.message}`);
        }
        if (!area) return res.json({ area: null });
        await store.saveConversation({
            sessionId,
            restaurantId: existing.restaurantId || 'public',
            visitorKey,
            trusted: true,
            restaurantName: existing.restaurantName || '',
            agent: { ...(existing.agent || {}), detectedArea: area },
        });
        return res.json({ area });
    } catch (error) {
        return clientError(res, error);
    }
});

router.post('/tool', async (req, res) => {
    try {
        if (tooMany(req.ip || 'unknown')) return res.status(429).json({ error: 'Too many requests.' });
        const sessionId = cleanSessionId(req.body?.sessionId);
        const visitorKey = cleanSessionId(req.body?.visitorKey);
        const existing = await ownedConversation(sessionId, visitorKey);
        if (!existing) return res.status(404).json({ error: 'Conversation not found' });
        const heard = Array.isArray(req.body?.heard) ? req.body.heard.map((line) => String(line || '').slice(0, 500)).slice(-12) : [];
        const outcome = await runWidgetTool({
            name: req.body?.name,
            args: req.body?.arguments || {},
            state: existing.agent || {},
            events: existing.events || [],
            sessionId,
            heard,
        });
        const restaurantId = outcome.state.restaurantId || existing.restaurantId || 'public';
        await store.saveConversation({
            sessionId,
            restaurantId,
            visitorKey,
            trusted: true,
            restaurantName: outcome.state.restaurantName || existing.restaurantName || '',
            guestName: outcome.state.guestName || null,
            phone: outcome.state.phone || outcome.state.booking?.phone || null,
            booking: outcome.state.booking || null,
            agent: outcome.state,
            appendEvents: outcome.confirmation ? [{
                id: eventId(),
                at: new Date().toISOString(),
                from: 'assistant',
                text: outcome.confirmation,
                kind: 'voice',
            }] : [],
        });
        return res.json(outcome.result);
    } catch (error) {
        return clientError(res, error);
    }
});

router.post('/conversations', async (req, res) => {
    try {
        const sessionId = cleanSessionId(req.body?.sessionId);
        const visitorKey = cleanSessionId(req.body?.visitorKey);
        const existing = await ownedConversation(sessionId, visitorKey);
        if (!existing) return res.status(404).json({ error: 'Conversation not found' });
        const welcome = welcomeMessage();
        const greetingSaved = (existing.events || []).some((event) => event.from !== 'visitor' && event.text === welcome);
        const appendEvents = (Array.isArray(req.body?.appendEvents) ? req.body.appendEvents : [])
            .slice(0, 20)
            .filter((event) => !(greetingSaved && event?.text === welcome && event?.from !== 'visitor'));
        const saved = await store.saveConversation({
            sessionId,
            restaurantId: existing.restaurantId || 'public',
            visitorKey,
            appendEvents,
            call: req.body?.call || null,
            websiteDomain: String(req.body?.websiteDomain || '').slice(0, 120),
        });
        const heard = appendEvents.filter((event) => event?.from === 'visitor').map((event) => event.text);
        const captured = detailsFromGuestLines(saved.agent || {}, heard);
        if (captured.changed) {
            await store.saveConversation({
                sessionId,
                restaurantId: captured.state.restaurantId || saved.restaurantId || 'public',
                visitorKey,
                trusted: true,
                guestName: captured.state.guestName || null,
                phone: captured.state.phone || null,
                agent: captured.state,
                restaurantName: captured.state.restaurantName || saved.restaurantName || '',
            });
        }
        return res.json({ success: true, sessionId: saved.sessionId });
    } catch (error) {
        return clientError(res, error);
    }
});

router.get('/conversations', async (req, res) => {
    try {
        const restaurantId = cleanRestaurantId(req.query.restaurantId);
        if (!restaurantId) return res.status(400).json({ error: 'restaurantId is required' });
        const tenant = await getTenantById(restaurantId);
        if (!tenant) return res.status(404).json({ error: 'Restaurant not found' });
        const page = await store.listConversations(restaurantId, {
            limit: req.query.limit,
            cursor: String(req.query.cursor || ''),
            kind: String(req.query.kind || ''),
            status: String(req.query.status || ''),
        });
        let data = page.data;
        const needle = String(req.query.q || '').trim().toLowerCase();
        if (needle) {
            data = data.filter((row) => `${row.guestName || ''} ${row.restaurantName || ''} ${row.phone || ''} ${row.preview || ''} ${row.websiteDomain || ''}`.toLowerCase().includes(needle));
        }
        if (req.query.unread === '1') data = data.filter((row) => row.unread > 0);
        return res.json({ success: true, count: data.length, data, nextCursor: page.nextCursor });
    } catch (error) {
        return clientError(res, error);
    }
});

router.get('/conversations/:sessionId', async (req, res) => {
    try {
        const sessionId = cleanSessionId(req.params.sessionId);
        const visitorKey = cleanSessionId(req.query.visitorKey);
        let row = visitorKey ? await ownedConversation(sessionId, visitorKey) : null;
        if (!row) {
            const restaurantId = cleanRestaurantId(req.query.restaurantId);
            row = await store.getConversation(restaurantId, sessionId);
            if (row?.unread) {
                row = await store.saveConversation({ sessionId, restaurantId, markRead: true });
            }
        }
        if (!row) return res.status(404).json({ error: 'Conversation not found' });
        const page = (row.events || []).length
            ? pageEvents(row.events, { limit: req.query.limit, before: req.query.before })
            : pageTranscript(row.transcript, { limit: req.query.limit, before: req.query.before });
        return res.json({
            success: true,
            conversation: {
                ...summaryOf(row),
                calls: row.calls || [],
                booking: summaryOf(row).booking,
                managerMessage: row.managerMessage || null,
            },
            messages: page.messages,
            nextBefore: page.nextBefore,
        });
    } catch (error) {
        return clientError(res, error);
    }
});

export default router;
