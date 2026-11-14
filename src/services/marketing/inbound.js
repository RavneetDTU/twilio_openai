// Decides whether an inbound WhatsApp message belongs to a marketing thread.
// Anything that is not a marketing reply, opt-out, or open marketing chat is
// returned as not handled so the booking host runs exactly as before.

import { classifyMarketingIntent, composeMarketingReply, knowledgeFromSources } from './agent.js';
import { applyDeliveryUpdate } from './engine.js';
import { optOutContact, recordInbound, recordOutboundAi } from './operations.js';
import { isOptOutText } from './phone.js';
import { mapMetaTemplateStatus } from './templates.js';
import { handleAiMessage } from '../whatsapp/whatsappAiAgent.js';
import { handleMessage } from '../whatsapp/whatsappHandlers.js';

async function conversationsForPhone(store, digits) {
    return store.list('conversations', [{ field: 'phoneDigits', op: '==', value: digits }]);
}

export async function routeInbound({ store, message, input, waId, profileName, session, deps, openai, model, loadTenant, getConfig, handoff = handoffToBooking }) {
    const text = input?.type === 'text' ? (input.text || '') : (input?.title || '');
    const digits = String(waId || '').replace(/\D/g, '');
    if (!digits || !message?.id) return { handled: false };

    const contextId = message?.context?.id || null;
    const linked = contextId ? await store.get('messages', contextId) : null;
    const contacts = await store.list('contacts', [{ field: 'phoneDigits', op: '==', value: digits }]);

    if (isOptOutText(text)) {
        const restaurantIds = new Set(contacts.map((contact) => contact.restaurantId));
        if (linked?.restaurantId) restaurantIds.add(linked.restaurantId);
        if (session?.restaurantId && session.restaurantId !== 'booki') restaurantIds.add(String(session.restaurantId));
        for (const restaurantId of restaurantIds) {
            await optOutContact(store, restaurantId, digits, 'whatsapp_stop');
        }
        if (deps?.client?.sendText) {
            await deps.client.sendText(waId, "You're opted out of marketing messages. We won't send promotions to this number.");
        }
        return { handled: true };
    }

    const rows = await conversationsForPhone(store, digits);
    const conversation = (linked?.conversationId && rows.find((row) => row.id === linked.conversationId))
        || rows.find((row) => session?.restaurantId && row.restaurantId === String(session.restaurantId))
        || rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0]
        || null;

    const isMarketing = Boolean(linked?.campaignId) || Boolean(conversation && conversation.handler !== 'booking');
    if (!isMarketing) return { handled: false };

    const restaurantId = linked?.restaurantId || conversation.restaurantId;
    const contact = contacts.find((item) => item.restaurantId === restaurantId) || null;
    const saved = await recordInbound(store, {
        restaurantId,
        phoneDigits: digits,
        name: profileName || contact?.name,
        text,
        wamid: message.id,
        campaignId: linked?.campaignId || conversation?.campaignId || null,
        contactId: contact?.id || null,
        reopenForCampaign: Boolean(linked?.campaignId),
    });

    if (linked?.wamid) {
        await applyDeliveryUpdate(store, { id: linked.wamid, status: 'replied', timestamp: `reply:${message.id}` });
    }
    if (deps?.client?.markRead) deps.client.markRead(message.id, { typing: saved.handler === 'ai' });

    if (saved.handler === 'human' || saved.handler === 'resolved') return { handled: true };

    const intent = classifyMarketingIntent(text);
    if (intent === 'human') {
        const reply = "I'll leave this with the team. Someone at the restaurant can continue from here.";
        await store.put('conversations', saved.id, { ...saved, handler: 'human', updatedAt: new Date().toISOString() });
        const sent = await deps.client.sendText(waId, reply);
        await recordOutboundAi(store, saved, { text: reply, wamid: sent?.messageId });
        return { handled: true };
    }

    if (intent === 'booking') {
        return handoff({ store, deps, input, session, restaurantId, waId, saved });
    }

    const tenant = typeof loadTenant === 'function' ? await loadTenant(restaurantId) : null;
    const settings = await store.get('settings', restaurantId);
    const campaign = saved.campaignId ? await store.get('campaigns', saved.campaignId) : null;
    const knowledge = knowledgeFromSources({ tenant, settings, config: typeof getConfig === 'function' ? getConfig() : {}, campaign });
    const history = (await store.list('messages', [{ field: 'conversationId', op: '==', value: saved.id }]))
        .filter((item) => item.restaurantId === restaurantId && item.id !== message.id)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        .slice(-12)
        .map((item) => ({ role: item.direction === 'inbound' ? 'user' : 'assistant', content: item.body || '' }));
    const reply = await composeMarketingReply({ text, knowledge, history, openai, model });
    const sent = await deps.client.sendText(waId, reply.text);
    await recordOutboundAi(store, saved, { text: reply.text, wamid: sent?.messageId });
    return { handled: true };
}

async function handoffToBooking({ store, deps, input, session, restaurantId, waId, saved }) {
    const restaurant = typeof deps.loadRestaurant === 'function' ? await deps.loadRestaurant(restaurantId) : null;
    if (!restaurant) {
        await deps.client.sendText(waId, "I can't open reservations for this restaurant right now. Please try again shortly.");
        return { handled: true };
    }
    const config = deps.getConfig();
    const ctx = {
        waId,
        profileName: saved.name,
        restaurant,
        client: deps.client,
        config,
        now: deps.now ? deps.now() : new Date(),
        availability: deps.availability,
        booking: deps.booking,
        contacts: deps.contacts,
        ai: deps.ai,
        directory: deps.directory || null,
        loadRestaurant: deps.loadRestaurant || null,
        hostRestaurant: deps.hostRestaurant,
    };
    const bookingSession = {
        mode: 'ai',
        restaurantId,
        history: session?.restaurantId === restaurantId ? (session.history || []) : [],
        data: session?.restaurantId === restaurantId ? (session.data || {}) : {},
        awaiting: session?.restaurantId === restaurantId ? (session.awaiting || null) : null,
        offeredRestaurants: session?.restaurantId === restaurantId ? (session.offeredRestaurants || []) : [],
        updatedAt: new Date(),
    };
    const useAi = config.conversationMode !== 'guided' && Boolean(deps.ai);
    const next = useAi
        ? await handleAiMessage(input, bookingSession, ctx)
        : await handleMessage(input, bookingSession, ctx);
    await store.put('conversations', saved.id, {
        ...saved,
        handler: 'booking',
        bookingHandoffAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });
    return { handled: true, session: next || null };
}

export async function applyStatuses(store, statuses = []) {
    for (const status of statuses) {
        await applyDeliveryUpdate(store, status);
    }
}

export async function applyTemplateUpdate(store, value) {
    const metaId = value?.message_template_id ? String(value.message_template_id) : '';
    const name = value?.message_template_name || '';
    const templates = await store.list('templates', []);
    const template = templates.find((item) => (metaId && item.metaId === metaId) || (name && item.name === name));
    if (!template) return { applied: false };
    const status = mapMetaTemplateStatus(value.event || value.status);
    await store.put('templates', template.id, {
        ...template,
        status,
        rejectionReason: value.reason || value.rejection_reason || template.rejectionReason || null,
        updatedAt: new Date().toISOString(),
    });
    return { applied: true, status };
}
