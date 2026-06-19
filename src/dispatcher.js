// src/dispatcher.js
// =============================================================================
// DATA-DRIVEN TENANT DISPATCHER — Firestore-backed
// =============================================================================
// Tenant routing config lives in Firestore (tenants / phoneIndex collections).
// To add a new restaurant: POST /api/restaurant/create — zero code changes.
//
// HOW ROUTING WORKS:
// Restaurants forward their existing business number to our shared Twilio number.
// Twilio provides the forwarded (restaurant's) number in the call metadata.
// We match that number against the phoneIndex collection in Firestore.
//
// UNKNOWN NUMBERS → Billy's Steakhouse (intentional default for testing/demos)
// Any unrecognised caller is routed to Billy's so new test clients can try the
// platform without needing to be registered first.
// =============================================================================

import { getTenantByPhone, getDefaultTenant } from './services/tenantService.js';
import { buildPromptForTenant } from './prompts/promptBuilder.js';
import logger from './utils/logger.js';

/**
 * Looks up tenant config from Firestore by the restaurant's forwarded phone number.
 * Falls back to Billy's Steakhouse (restaurantId "1") for unknown numbers —
 * intentional so test clients can try the platform without registration.
 *
 * Returns a persona-compatible object so server.js needs no changes.
 * The `instructions` getter calls buildPromptForTenant fresh on every access.
 *
 * @param {string} forwardedNumber - The restaurant's business number from Twilio
 * @returns {Promise<Object>} Tenant persona object
 */
export async function getTenantByNumber(forwardedNumber) {
    logger.info(`🧠 Dispatcher resolving tenant for: ${forwardedNumber}`);

    // Try phoneIndex lookup in Firestore (cache-first)
    let tenant = await getTenantByPhone(forwardedNumber);

    // Unknown number → fall back to Billy's intentionally
    if (!tenant) {
        logger.warn(`⚠️ No tenant for ${forwardedNumber} — routing to default (Billy's) for testing.`);
        tenant = await getDefaultTenant();
    }

    if (!tenant) {
        throw new Error('CRITICAL: Default tenant (Billy\'s, restaurantId "1") not found in Firestore');
    }

    logger.info(`✅ Tenant resolved: "${tenant.name}" (${tenant.restaurantId})`);

    return {
        id:           tenant.restaurantId,
        restaurantId: tenant.restaurantId,
        name:         tenant.name,
        model:        tenant.model        || 'gpt-realtime-2',
        voice:        tenant.voice        || 'marin',
        temperature:  tenant.temperature  ?? 0.8,
        speed:        tenant.speed        || undefined,
        // Fresh prompt built on every call — picks up latest config from Firestore
        get instructions() {
            return buildPromptForTenant(tenant);
        },
    };
}