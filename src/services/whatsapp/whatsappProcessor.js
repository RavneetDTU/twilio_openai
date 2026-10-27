// src/services/whatsapp/whatsappProcessor.js
// =============================================================================
// WHATSAPP WEBHOOK PROCESSOR
// =============================================================================
// Runs after POST /webhook has already answered 200. For every inbound message:
//   1. skip duplicates (Meta retries) by message id
//   2. resolve the restaurant (WA_RESTAURANT_ID → phoneIndex → Billy's)
//   3. load the session, run the flow, save or clear the session
// Messages from the same number are handled one at a time.
// All dependencies are passed in, so this file has no Firestore/network imports.
// =============================================================================

import logger from '../../utils/logger.js';
import { DEFAULT_TIMEZONE } from './whatsappConfig.js';
import { handleMessage } from './whatsappHandlers.js';

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
    };
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

    deps.client.markRead(message.id);

    const restaurant = await deps.resolveRestaurant(metadata);
    if (!restaurant) {
        logger.error(`❌ [WhatsApp] No restaurant resolved for message ${message.id}`);
        return;
    }

    let session = null;
    try {
        session = await deps.store.get(waId);
    } catch (error) {
        logger.error(`❌ [WhatsApp] Loading session for ${waId} failed: ${error.message} — starting fresh`);
    }

    const ctx = {
        waId,
        profileName,
        restaurant,
        client: deps.client,
        config: deps.getConfig(),
        now: deps.now ? deps.now() : new Date(),
        availability: deps.availability,
        booking: deps.booking,
        contacts: deps.contacts,
    };

    logger.info(`💬 [WhatsApp] ${waId} → ${restaurant.id} step=${session?.step || 'new'} input=${input.type}${input.id ? `:${input.id}` : ''}`);
    const next = await handleMessage(input, session, ctx);

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
