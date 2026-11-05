// src/services/whatsapp/whatsappProcessor.js
// =============================================================================
// WHATSAPP WEBHOOK PROCESSOR
// =============================================================================
// Runs after POST /webhook has already answered 200. For every inbound message:
//   1. skip duplicates (Meta retries) by message id
//   2. restaurant: session pick → live tenant; otherwise Booki AI host (never Billy's)
//   3. load the session, run the flow, save or clear the session
// Messages from the same number are handled one at a time.
// All dependencies are passed in, so this file has no Firestore/network imports.
// =============================================================================

import logger from '../../utils/logger.js';
import { DEFAULT_TIMEZONE } from './whatsappConfig.js';
import { handleAiMessage } from './whatsappAiAgent.js';
import { handleMessage } from './whatsappHandlers.js';
import { bookiHostRestaurant, HOST_RESTAURANT_ID, isHostRestaurantId } from './whatsappRestaurantDirectory.js';

const chains = new Map();

function runExclusive(key, task) {
    const previous = chains.get(key) || Promise.resolve();
    const next = previous.then(task, task);
    chains.set(key, next);
    const cleanup = () => {
        if (chains.get(key) === next) chains.delete(key);
    };
    next.then(cleanup, cleanup);
    return next;
}

/** Meta message → flow input. Returns null for messages to ignore. */
export function parseIncomingMessage(message) {
    switch (message?.type) {
        case 'text':
            return { type: 'text', text: message.text?.body || '' };
        case 'interactive': {
            const reply = message.interactive?.button_reply || message.interactive?.list_reply;
            return reply
                ? { type: 'reply', id: String(reply.id || ''), title: reply.title || '' }
                : { type: 'unsupported', kind: 'interactive' };
        }
        case 'button':
            return { type: 'reply', id: String(message.button?.payload || ''), title: message.button?.text || '' };
        case 'reaction':
        case 'system':
            return null;
        default:
            return { type: 'unsupported', kind: message?.type || 'unknown' };
    }
}

/** Tenant config → the restaurant shape the flow uses. */
export function restaurantFromTenant(tenant, config = {}) {
    if (!tenant) return null;
    return {
        id: String(tenant.restaurantId),
        name: tenant.name || 'our restaurant',
        timezone: tenant.settings?.timezone || config.timezone || DEFAULT_TIMEZONE,
        currency: tenant.settings?.currency || 'ZAR',
        depositAmount: Number(tenant.depositAmount || tenant.settings?.depositAmount) || 0,
        operatingHours: tenant.operatingHours || null,
        address: tenant.directory?.street_address || '',
        city: tenant.directory?.city || '',
        cuisine: tenant.directory?.cuisine || '',
        phone: Array.isArray(tenant.phoneNumbers) ? String(tenant.phoneNumbers[0] || '') : '',
    };
}

async function resolveSessionRestaurant(session, metadata, deps, config) {
    const selectedId = session?.restaurantId;
    if (selectedId && !isHostRestaurantId(selectedId) && typeof deps.loadRestaurant === 'function') {
        const loaded = await deps.loadRestaurant(selectedId);
        if (loaded && !isHostRestaurantId(loaded.id)) return { restaurant: loaded, session };
        logger.warn(`⚠️ [WhatsApp] Session restaurant ${selectedId} is not available — asking the guest to choose again`);
        return {
            restaurant: typeof deps.hostRestaurant === 'function' ? deps.hostRestaurant() : bookiHostRestaurant(config),
            session: { ...session, restaurantId: HOST_RESTAURANT_ID, awaiting: 'location' },
        };
    }

    if (typeof deps.hostRestaurant === 'function') return { restaurant: deps.hostRestaurant(), session };
    if (typeof deps.resolveRestaurant === 'function') return { restaurant: await deps.resolveRestaurant(metadata), session };
    return { restaurant: bookiHostRestaurant(config), session };
}

function logStatuses(statuses = []) {
    for (const status of statuses) {
        if (status?.status !== 'failed') continue;
        const error = status.errors?.[0] || {};
        logger.warn(
            `⚠️ [WhatsApp] Delivery failed to ${status.recipient_id} (${status.id}): ` +
            `code=${error.code ?? '-'} ${error.title || ''} ${error.error_data?.details || ''}`.trim()
        );
    }
}

/**
 * @param {Object} deps
 * @param {Object} deps.store         session + dedupe store
 * @param {Object} deps.client        WhatsApp client
 * @param {Object} deps.availability  { getDaySlots }
 * @param {Object} deps.booking       { checkSlot, findAlternatives, book }
 * @param {Object} deps.contacts      { getKnownName, saveBooking }
 * @param {Function} deps.resolveRestaurant  (metadata) => Promise<restaurant|null>
 * @param {Function} deps.getConfig
 * @param {Function} [deps.now]
 */
async function processMessage(message, metadata, profileName, deps) {
    const input = parseIncomingMessage(message);
    if (!input) return;

    const waId = String(message.from || '');
    if (!waId || !message.id) return;

    let firstTime = true;
    try {
        firstTime = await deps.store.markMessageProcessed(message.id, { from: waId, type: message.type || null });
    } catch (error) {
        logger.error(`❌ [WhatsApp] Dedupe check failed for ${message.id}: ${error.message} — processing anyway`);
    }
    if (!firstTime) {
        logger.info(`🔁 [WhatsApp] Duplicate message ${message.id} ignored`);
        return;
    }

    const config = deps.getConfig();
    const aiMode = config.conversationMode !== 'guided' && Boolean(deps.ai);
    deps.client.markRead(message.id, { typing: aiMode });

    let session = null;
    try {
        session = await deps.store.get(waId);
    } catch (error) {
        logger.error(`❌ [WhatsApp] Loading session for ${waId} failed: ${error.message} — starting fresh`);
    }

    const resolved = await resolveSessionRestaurant(session, metadata, deps, config);
    session = resolved.session;
    const restaurant = resolved.restaurant;
    if (!restaurant) {
        logger.error(`❌ [WhatsApp] No restaurant resolved for message ${message.id}`);
        return;
    }

    const ctx = {
        waId,
        profileName,
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
        hostRestaurant: deps.hostRestaurant || (() => bookiHostRestaurant(config)),
    };

    const state = aiMode ? 'ai' : (session?.step || 'new');
    logger.info(`💬 [WhatsApp] ${waId} → ${restaurant.id} mode=${state} input=${input.type}${input.id ? `:${input.id}` : ''}`);
    const next = aiMode
        ? await handleAiMessage(input, session, ctx)
        : await handleMessage(input, session, ctx);

    if (next) await deps.store.save(waId, next);
    else await deps.store.clear(waId);
}

/** Processes one webhook body. Never throws. */
export async function processWhatsAppWebhook(body, deps) {
    if (body?.object !== 'whatsapp_business_account') {
        logger.warn(`⚠️ [WhatsApp] Ignoring webhook with object "${body?.object}"`);
        return;
    }

    const { phoneId } = deps.getConfig();
    const tasks = [];

    for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
            if (change?.field !== 'messages') continue;
            const value = change.value || {};
            logStatuses(value.statuses);

            if (phoneId && value.metadata?.phone_number_id && value.metadata.phone_number_id !== phoneId) {
                logger.warn(`⚠️ [WhatsApp] Message for phone_number_id ${value.metadata.phone_number_id} ignored (WA_PHONE_ID is ${phoneId})`);
                continue;
            }

            const names = new Map((value.contacts || []).map((c) => [String(c.wa_id), c.profile?.name || null]));
            for (const message of value.messages || []) {
                const waId = String(message.from || '');
                tasks.push(
                    runExclusive(waId, () => processMessage(message, value.metadata, names.get(waId) || null, deps))
                        .catch((error) => logger.error(`❌ [WhatsApp] Processing ${message.id} failed: ${error.stack || error.message}`))
                );
            }
        }
    }

    await Promise.all(tasks);
}
