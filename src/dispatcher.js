// src/dispatcher.js
// =============================================================================
// DATA-DRIVEN TENANT DISPATCHER
// =============================================================================
// Routing config lives in prompts.json — NOT in this file.
// To add a new restaurant: add it to prompts.json with a phoneNumbers array.
// Zero changes needed here.
//
// HOW ROUTING WORKS:
// Restaurants forward their existing business number to our shared Twilio number.
// Twilio provides the forwarded (restaurant's) number in the call metadata.
// We match that forwarded number against the phoneNumbers array in each tenant config.
//
// UNKNOWN NUMBERS → Billy's Steakhouse (intentional default for testing/demos)
// Any unrecognised caller is routed to Billy's so new test clients can try the
// platform without needing to be registered first.
// =============================================================================

import { createRequire } from 'module';
import { buildPromptForTenant } from './prompts/promptBuilder.js';
import logger from './utils/logger.js';

const require = createRequire(import.meta.url);

/**
 * Looks up tenant config from prompts.json by the restaurant's forwarded phone number.
 * Falls back to Billy's Steakhouse (restaurantId: "1") for unknown numbers —
 * this is intentional so new clients can test the platform without registration.
 *
 * @param {string} forwardedNumber - The restaurant's business number as provided by Twilio
 * @returns {Object} tenantConfig - Full tenant object with an additional `instructions` getter
 */
export function getTenantByNumber(forwardedNumber) {
    logger.info(`🧠 Dispatcher resolving tenant for number: ${forwardedNumber}`);

    // Re-read JSON fresh so newly added restaurants are available without restart.
    // Path is relative to dispatcher.js which lives inside src/
    const jsonPath = './prompts/prompts.json';
    delete require.cache[require.resolve(jsonPath)];
    const data = require(jsonPath);

    // 1. Try to find a registered tenant that owns this forwarded number
    let tenant = data.restaurants.find(r =>
        Array.isArray(r.phoneNumbers) && r.phoneNumbers.includes(forwardedNumber)
    );

    // 2. If no match — fall back to Billy's (restaurantId "1") intentionally
    if (!tenant) {
        logger.warn(`⚠️ No tenant registered for ${forwardedNumber} — routing to default (Billy's) for testing.`);
        tenant = data.restaurants.find(r => r.restaurantId === '1');
    }

    if (!tenant) {
        // This should never happen as long as Billy's exists in prompts.json
        throw new Error('CRITICAL: Default tenant (Billy\'s, restaurantId "1") not found in prompts.json');
    }

    logger.info(`✅ Tenant resolved: "${tenant.name}" (restaurantId: ${tenant.restaurantId})`);

    // Return a persona-compatible object so server.js needs minimal changes.
    // The `instructions` getter calls buildPromptForTenant fresh each time
    // — same pattern as the old per-restaurant bot_model files.
    return {
        id:          tenant.restaurantId,       // used by server.js for capacity lookup
        restaurantId: tenant.restaurantId,      // explicit alias for clarity
        name:        tenant.name,
        model:       tenant.model        || 'gpt-realtime-2',
        voice:       tenant.voice        || 'marin',
        temperature: tenant.temperature  ?? 0.8,
        speed:       tenant.speed        || undefined,
        get instructions() {
            return buildPromptForTenant(tenant);
        },
    };
}