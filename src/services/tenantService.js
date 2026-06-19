// src/services/tenantService.js
// =============================================================================
// TENANT SERVICE — Firestore-backed tenant config with in-memory cache
// =============================================================================
// All reads/writes for restaurant configuration go through this file.
// Collections:
//   tenants/{restaurantId}  — full restaurant config
//   phoneIndex/{phone}      — fast lookup: phone number → restaurantId
//
// Cache: simple in-process Map with 5-minute TTL.
// Invalidated on every write so updates apply immediately.
// =============================================================================

import { db } from '../config/firebase.js';
import logger from '../utils/logger.js';
import { randomUUID } from 'crypto';

// ── IN-MEMORY CACHE ───────────────────────────────────────────────────────────
const TTL_MS = 5 * 60 * 1000; // 5 minutes
const _cache = new Map();

function _getCached(key) {
    const entry = _cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { _cache.delete(key); return null; }
    return entry.value;
}
function _setCached(key, value) {
    _cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
}
function _invalidate(key) {
    _cache.delete(key);
}
function _invalidateAll() {
    _cache.clear();
}

// ── PHONE SANITISATION ────────────────────────────────────────────────────────
// Firestore document IDs cannot contain '/' or certain chars.
// We keep the leading '+' but strip everything else unusual.
function sanitisePhone(phone) {
    return phone.replace(/[^0-9+]/g, '');
}

// =============================================================================
// READ — Get tenant by phone number (the hot path — called on every call)
// =============================================================================

/**
 * Looks up a tenant config by the restaurant's forwarded phone number.
 * Returns null if not found (caller should fall back to Billy's / default).
 *
 * Cache-first: hits Firestore only on the first call per phone per 5 minutes.
 *
 * @param {string} forwardedNumber  The restaurant's business phone number
 * @returns {Promise<Object|null>}  Full tenant config object, or null
 */
export async function getTenantByPhone(forwardedNumber) {
    const cacheKey = `phone:${forwardedNumber}`;
    const cached = _getCached(cacheKey);
    if (cached) {
        logger.info(`⚡ Cache hit for ${forwardedNumber} → ${cached.name}`);
        return cached;
    }

    try {
        // Step 1 — fast O(1) lookup in phoneIndex
        const sanitised = sanitisePhone(forwardedNumber);
        const indexDoc = await db.collection('phoneIndex').doc(sanitised).get();

        if (!indexDoc.exists) {
            logger.warn(`⚠️ No phoneIndex entry for ${forwardedNumber}`);
            return null;
        }

        const { restaurantId } = indexDoc.data();

        // Step 2 — fetch full tenant config
        const tenant = await getTenantById(restaurantId);
        if (!tenant) return null;

        _setCached(cacheKey, tenant);
        return tenant;

    } catch (error) {
        logger.error(`❌ getTenantByPhone failed for ${forwardedNumber}: ${error.message}`);
        return null;
    }
}

// =============================================================================
// READ — Get tenant by restaurantId (used by config APIs)
// =============================================================================

/**
 * Fetches a full tenant config from Firestore by restaurantId.
 * @param {string} restaurantId
 * @returns {Promise<Object|null>}
 */
export async function getTenantById(restaurantId) {
    const cacheKey = `tenant:${restaurantId}`;
    const cached = _getCached(cacheKey);
    if (cached) return cached;

    try {
        const doc = await db.collection('tenants').doc(restaurantId).get();
        if (!doc.exists) {
            logger.warn(`⚠️ No tenant found for restaurantId: ${restaurantId}`);
            return null;
        }

        const tenant = { restaurantId, ...doc.data() };
        _setCached(cacheKey, tenant);
        return tenant;

    } catch (error) {
        logger.error(`❌ getTenantById failed for ${restaurantId}: ${error.message}`);
        return null;
    }
}

// =============================================================================
// READ — Get the default tenant (Billy's, restaurantId "1")
// Called as fallback when no phone match is found.
// =============================================================================

export async function getDefaultTenant() {
    return getTenantById('1');
}

// =============================================================================
// WRITE — Create a new tenant (onboarding API)
// =============================================================================

/**
 * Standard operating hours template — Mon–Sun, noon to 10pm.
 * Used as default when onboarding a new restaurant.
 */
const DEFAULT_OPERATING_HOURS = {
    Monday:    { open: '12:00 PM', close: '10:00 PM' },
    Tuesday:   { open: '12:00 PM', close: '10:00 PM' },
    Wednesday: { open: '12:00 PM', close: '10:00 PM' },
    Thursday:  { open: '12:00 PM', close: '10:00 PM' },
    Friday:    { open: '12:00 PM', close: '11:00 PM' },
    Saturday:  { open: '11:00 AM', close: '11:00 PM' },
    Sunday:    { open: '11:00 AM', close: '9:00 PM'  },
};

/**
 * Standard question flow — the 7-question booking sequence used by all restaurants.
 * restaurantId is injected into the question IDs so they are unique per tenant.
 */
function buildDefaultQuestionFlow(restaurantId) {
    const prefix = `q_default_${restaurantId}`;
    return [
        { id: `${prefix}_001`, title: 'Greeting',      order: 1, botMessage: '', isRequired: true,  instructions: null },
        { id: `${prefix}_002`, title: 'Name Capture',  order: 2, botMessage: "May I have the name for the reservation?", isRequired: true, instructions: 'Skip if already given.' },
        { id: `${prefix}_003`, title: 'Phone Capture', order: 3, botMessage: "What's the best phone number to confirm the booking?", isRequired: true, instructions: 'Use STRICT DATA CAPTURE PROTOCOL (Anti-Hallucination Mode). Minimum 9 digits. Literal read-back required.' },
        { id: `${prefix}_004`, title: 'Date & Time',   order: 4, botMessage: "What date and time would you prefer?", isRequired: true, instructions: 'Check against operating hours.' },
        { id: `${prefix}_005`, title: 'Party Size',    order: 5, botMessage: "How many guests will be dining?", isRequired: true, instructions: null },
        { id: `${prefix}_006`, title: 'Allergies',     order: 6, botMessage: "Does anyone in the party have any allergies we should note?", isRequired: true, instructions: null },
        { id: `${prefix}_007`, title: 'Confirmation',  order: 7, botMessage: "Just to confirm: a table under [name] for [number] guests on [date] at [time]. Contact: [phone]. Allergies: [details or 'none noted']. Is that correct?", isRequired: true, instructions: null },
    ];
}

/**
 * Creates a new restaurant tenant in Firestore with smart defaults.
 *
 * Required: name, phoneNumbers, email, depositAmount, totalCapacity
 * Optional: restaurantId, currency, timezone, venueType, voice, greetingMessage, operatingHours
 *
 * @param {Object} input
 * @param {string}   input.name             - Restaurant display name
 * @param {string[]} input.phoneNumbers      - Array of forwarded business phone numbers (E.164)
 * @param {string}   input.email             - Restaurant notification email
 * @param {number}   input.depositAmount     - Deposit per person
 * @param {number}   input.totalCapacity     - Max guests per day
 * @param {string}   [input.restaurantId]    - Custom ID (e.g. "6", "myplace_01"). Auto-generated if omitted.
 * @param {string}   [input.currency]        - Defaults to 'rand'
 * @param {string}   [input.timezone]        - Defaults to 'Africa/Johannesburg'
 * @param {string}   [input.venueType]       - Defaults to 'restaurant'
 * @param {string}   [input.voice]           - Defaults to 'marin'
 * @param {string}   [input.greetingMessage] - Custom greeting. Auto-generated from name if omitted.
 * @param {Object}   [input.operatingHours]  - Defaults to Mon–Sun standard hours
 * @returns {Promise<Object>} The created tenant config
 */
export async function createTenant(input) {
    const {
        name,
        phoneNumbers,
        email,
        depositAmount,
        totalCapacity,
        restaurantId:   requestedId,          // required — must match dashboard system ID
        currency        = 'rand',
        timezone        = 'Africa/Johannesburg',
        venueType       = 'restaurant',
        voice           = 'marin',
        greetingMessage,
        operatingHours  = DEFAULT_OPERATING_HOURS,
    } = input;

    // Validate required fields
    if (!name)                          throw new Error('Missing required field: name');
    if (!phoneNumbers?.length)          throw new Error('Missing required field: phoneNumbers');
    if (!email)                         throw new Error('Missing required field: email');
    if (depositAmount === undefined)    throw new Error('Missing required field: depositAmount');
    if (totalCapacity === undefined)    throw new Error('Missing required field: totalCapacity');
    if (!requestedId?.toString().trim()) throw new Error('Missing required field: restaurantId');

    // Use the provided restaurantId exactly — must match your dashboard system
    const restaurantId = requestedId.toString().trim();

    // Reject if that ID is already in use (prevents silent overwrite)
    const existing = await db.collection('tenants').doc(restaurantId).get();
    if (existing.exists) {
        throw new Error(`DUPLICATE_ID: Restaurant with ID "${restaurantId}" already exists. Use a different restaurantId or omit it to auto-generate.`);
    }

    // Build question flow with auto-generated greeting
    const finalGreeting = greetingMessage
        || `Hello! Welcome to ${name} — I can assist you with a table reservation or pass a message to the manager. How can I help you today?`;

    const questionFlow = buildDefaultQuestionFlow(restaurantId);
    // Inject the greeting message into the Greeting question
    questionFlow[0].botMessage = finalGreeting;

    const tenantData = {
        name,
        phoneNumbers,
        model:       'gpt-realtime-2',
        voice,
        temperature: 0.8,
        venueType,
        isActive:    true,
        settings: {
            depositAmount:       Number(depositAmount),
            currency,
            timezone,
            RestaurantEmail:     email,
            totalCapacity:       Number(totalCapacity),
            otherBookingsByDate: {},
        },
        operatingHours,
        questionFlow,
        createdAt:  new Date(),
        updatedAt:  new Date(),
    };

    // 1. Write tenant document
    await db.collection('tenants').doc(restaurantId).set(tenantData);

    // 2. Write phoneIndex entries (one per phone number)
    const batch = db.batch();
    for (const phone of phoneNumbers) {
        const docId = sanitisePhone(phone);
        batch.set(db.collection('phoneIndex').doc(docId), { restaurantId });
    }
    await batch.commit();

    logger.info(`✅ Tenant created: "${name}" (${restaurantId}) with ${phoneNumbers.length} phone(s)`);

    return { restaurantId, ...tenantData };
}

// =============================================================================
// WRITE — Update an existing tenant's settings / hours / questionFlow
// =============================================================================

/**
 * Merges partial updates into a tenant document.
 * Invalidates cache so the next call reads fresh data.
 *
 * @param {string} restaurantId
 * @param {Object} updates  Partial update — any subset of: settings, operatingHours, questionFlow
 * @returns {Promise<Object>} Updated tenant config
 */
export async function updateTenant(restaurantId, updates) {
    const docRef = db.collection('tenants').doc(restaurantId);
    const doc = await docRef.get();

    if (!doc.exists) throw new Error(`Restaurant not found with ID: ${restaurantId}`);

    const existing = doc.data();

    const merged = {
        updatedAt: new Date(),
    };

    if (updates.settings) {
        merged.settings = { ...existing.settings, ...updates.settings };
    }
    if (updates.operatingHours) {
        merged.operatingHours = { ...existing.operatingHours, ...updates.operatingHours };
    }
    if (updates.questionFlow !== undefined) {
        merged.questionFlow = updates.questionFlow;
    }

    await docRef.update(merged);

    // Invalidate cache for this tenant and all its phone numbers
    _invalidate(`tenant:${restaurantId}`);
    const phones = existing.phoneNumbers || [];
    for (const p of phones) _invalidate(`phone:${p}`);

    logger.info(`✅ Tenant updated: ${restaurantId}`);
    return { restaurantId, ...existing, ...merged };
}

// =============================================================================
// WRITE — Add a question to a tenant's questionFlow
// =============================================================================

/**
 * Adds a new question to a tenant's questionFlow.
 * Inserts at second-last position (before the Confirmation step).
 * Auto-generates id and order.
 */
export async function addTenantQuestion(restaurantId, newQuestion) {
    const { title, botMessage, isRequired, instructions = null } = newQuestion || {};
    if (!title)      throw new Error('Missing required question field: title');
    if (!botMessage) throw new Error('Missing required question field: botMessage');
    if (isRequired === undefined) throw new Error('Missing required question field: isRequired');

    const docRef = db.collection('tenants').doc(restaurantId);
    const doc = await docRef.get();
    if (!doc.exists) throw new Error(`Restaurant not found with ID: ${restaurantId}`);

    const data = doc.data();
    const sorted = [...data.questionFlow].sort((a, b) => a.order - b.order);

    const generatedId = `q_${randomUUID()}`;
    const insertAt = sorted.length > 1 ? sorted.length - 1 : sorted.length;
    sorted.splice(insertAt, 0, {
        id: generatedId,
        title,
        botMessage,
        isRequired: Boolean(isRequired),
        instructions,
    });

    // Re-number orders 1, 2, 3 … N
    sorted.forEach((q, i) => { q.order = i + 1; });

    await docRef.update({ questionFlow: sorted, updatedAt: new Date() });

    _invalidate(`tenant:${restaurantId}`);
    const phones = data.phoneNumbers || [];
    for (const p of phones) _invalidate(`phone:${p}`);

    logger.info(`✅ Question "${title}" (${generatedId}) added to ${restaurantId}`);
    return { restaurantId, ...data, questionFlow: sorted };
}

// =============================================================================
// WRITE — Delete a question from a tenant's questionFlow
// =============================================================================

export async function deleteTenantQuestion(restaurantId, questionId) {
    const docRef = db.collection('tenants').doc(restaurantId);
    const doc = await docRef.get();
    if (!doc.exists) throw new Error(`Restaurant not found with ID: ${restaurantId}`);

    const data = doc.data();
    const exists = data.questionFlow.find(q => q.id === questionId);
    if (!exists) throw new Error(`NOT_FOUND: No question with id "${questionId}"`);

    const filtered = data.questionFlow
        .filter(q => q.id !== questionId)
        .sort((a, b) => a.order - b.order);
    filtered.forEach((q, i) => { q.order = i + 1; });

    await docRef.update({ questionFlow: filtered, updatedAt: new Date() });

    _invalidate(`tenant:${restaurantId}`);
    const phones = data.phoneNumbers || [];
    for (const p of phones) _invalidate(`phone:${p}`);

    logger.info(`✅ Question "${questionId}" deleted from ${restaurantId}`);
    return { restaurantId, ...data, questionFlow: filtered };
}
