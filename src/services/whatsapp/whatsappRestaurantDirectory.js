// src/services/whatsapp/whatsappRestaurantDirectory.js
// =============================================================================
// WHATSAPP — restaurants a guest can choose from (read-only)
// =============================================================================
// Restaurants: active Firestore tenants (tenantService.listTenants / getTenantById).
// Location:    Mybooki address saved in the dashboard (Settings → Address):
//              GET https://mybookiapis.booki.co.za/restaurants/:id/address
//              → { street_address, city, province_state, postal_code }
// Matching is token overlap against area, address, province, name and postcode.
// No maps API. A tenant without a saved address can still be found by name.
// The list is cached for 10 minutes and holds no guest data.
// =============================================================================

import logger from '../../utils/logger.js';
import { clip } from './whatsappClient.js';
import { DEFAULT_TIMEZONE, WA_LIMITS } from './whatsappConfig.js';

const RESERVATION_API_BASE = 'https://mybookiapis.booki.co.za/restaurants';
const CACHE_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;
export const SUGGESTION_LIMIT = 4;
export const HOST_RESTAURANT_ID = 'booki';

const STOP_WORDS = new Set([
    'the', 'a', 'an', 'in', 'at', 'near', 'around', 'to', 'of', 'and', 'or', 'for',
    'please', 'looking', 'look', 'dine', 'dining', 'eat', 'eating', 'area', 'areas',
    'location', 'restaurant', 'restaurants', 'resturant', 'place', 'places', 'want',
    'would', 'like', 'book', 'booking', 'table', 'tables', 'reservation',
    'tell', 'which', 'where', 'what', 'show', 'list', 'suggest', 'suggested',
    'hotel', 'hotels', 'could', 'try', 'find', 'here', 'your', 'you', 'have', 'has',
    'city', 'cities', 'neighbourhood', 'neighborhood', 'nearby',
]);

/** Host used until the guest picks a restaurant. Not a Firestore tenant. */
export function bookiHostRestaurant(config = {}) {
    return {
        id: HOST_RESTAURANT_ID,
        name: 'Booki AI',
        timezone: config.timezone || DEFAULT_TIMEZONE,
        currency: 'ZAR',
        depositAmount: 0,
        operatingHours: null,
    };
}

export function isHostRestaurantId(id) {
    return !id || String(id) === HOST_RESTAURANT_ID;
}

/** "VredenburgVredenburg" → "Vredenburg" (a value saved twice in the dashboard). */
export function cleanArea(city) {
    const value = String(city || '').trim();
    const doubled = value.match(/^(.+?)\1$/i);
    return (doubled ? doubled[1] : value).trim();
}

function describeVenue(venueType) {
    const value = String(venueType || '').trim();
    if (!value || value.toLowerCase() === 'restaurant') return '';
    return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * @returns {{id: string, name: string, area: string, province: string, address: string,
 *            postalCode: string, description: string, phone: string}}
 */
export function toDirectoryEntry(tenant, address) {
    const id = String(tenant.restaurantId);
    return {
        id,
        name: String(tenant.name || '').trim() || `Restaurant ${id}`,
        area: cleanArea(address?.city),
        province: String(address?.province_state || '').trim(),
        address: String(address?.street_address || '').trim(),
        postalCode: String(address?.postal_code || '').trim(),
        description: describeVenue(tenant.venueType),
        phone: Array.isArray(tenant.phoneNumbers) ? String(tenant.phoneNumbers[0] || '') : '',
    };
}

/** "Unit G, 3 Mossel Street" + "Vredenburg" → "Unit G, 3 Mossel Street, Vredenburg" */
export function locationLine(entry) {
    const { address, area } = entry;
    if (address && area && !address.toLowerCase().includes(area.toLowerCase())) return `${address}, ${area}`;
    return address || area || '';
}

/** Restaurant phone + address, used as "Contact Us" details for the chosen restaurant. */
export function contactLine(entry) {
    return [entry.phone, locationLine(entry)].filter(Boolean).join('\n');
}

export function tokenise(query) {
    return cleanArea(query)
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

export function scoreMatch(entry, tokens) {
    if (!tokens.length) return 0;
    const area = String(entry.area || '').toLowerCase();
    const name = String(entry.name || '').toLowerCase();
    const address = String(entry.address || '').toLowerCase();
    const postal = String(entry.postalCode || '').toLowerCase();
    const province = String(entry.province || '').toLowerCase();
    const phrase = tokens.join(' ');

    let score = 0;
    if (area && (area === phrase || area.includes(phrase))) score += 10;
    else if (address.includes(phrase) && phrase.length >= 4) score += 6;
    else if (name.includes(phrase) && phrase.length >= 4) score += 5;
    if (province && phrase.length >= 8 && (province === phrase || province.includes(phrase))) score += 8;

    for (const token of tokens) {
        if (area === token) score += 6;
        else if (area.includes(token)) score += 4;
        else if (name.includes(token)) score += 3;
        else if (address.includes(token)) score += 2;
        else if (postal === token) score += 1;
    }
    return score;
}

/**
 * @returns {{matches: object[], unmatched: boolean}}
 */
export function matchRestaurants(entries, location, { limit = SUGGESTION_LIMIT } = {}) {
    const tokens = tokenise(location);
    if (!tokens.length) return { matches: [], unmatched: true };

    const scored = (entries || [])
        .map((entry) => ({ entry, score: scoreMatch(entry, tokens) }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));

    if (!scored.length) return { matches: [], unmatched: true };
    return { matches: scored.slice(0, limit).map((row) => row.entry), unmatched: false };
}

function interestHay(entry) {
    return [entry.name, entry.description, entry.area].join(' ').toLowerCase();
}

function scoreInterest(entry, tokens) {
    if (!tokens.length) return 0;
    const hay = interestHay(entry);
    let score = 0;
    for (const token of tokens) {
        if (hay.includes(token)) score += 2;
        if (token === 'steak' && hay.includes('steakhouse')) score += 3;
        if (token === 'wine' && hay.includes('wine')) score += 3;
        if ((token === 'veg' || token === 'vegetarian' || token === 'vegan') && /veg/.test(hay)) score += 3;
        if (token === 'seafood' && (hay.includes('seafood') || hay.includes('fish'))) score += 3;
        if ((token === 'date' || token === 'romantic') && hay.includes('wine')) score += 2;
        if ((token === 'family' || token === 'kids') && hay.includes('restaurant')) score += 1;
    }
    return score;
}

/**
 * Re-orders location matches using preference + food interest. Never drops a
 * location match — unmatched food just leaves the original area order.
 */
export function rankRecommendations(entries, { preference, food, limit = SUGGESTION_LIMIT } = {}) {
    const foodTokens = tokenise(food);
    const prefTokens = tokenise(preference);
    const ranked = (entries || [])
        .map((entry) => ({
            entry,
            extra: scoreInterest(entry, foodTokens) * 2 + scoreInterest(entry, prefTokens),
        }))
        .sort((a, b) => b.extra - a.extra || a.entry.name.localeCompare(b.entry.name));
    return ranked.slice(0, limit).map((row) => row.entry);
}

function digitsOnly(value) {
    const match = String(value || '').trim().match(/^(\d{1,2})(?:[.)]|\b)/);
    return match ? Number(match[1]) : null;
}

/**
 * Guest picks from the list just shown: list row, "1"/"2", or a name.
 * Only ids in `offered` are accepted.
 */
export function pickFromOffered(input, offered = []) {
    if (!offered.length) return null;

    if (input?.type === 'reply') {
        const id = String(input.id || '');
        const fromReply = id.startsWith('rest:') ? id.slice(5) : id;
        return offered.find((entry) => entry.id === fromReply) || null;
    }

    const raw = String(input?.text || input?.title || '').trim();
    if (!raw) return null;

    const index = digitsOnly(raw);
    if (index >= 1 && index <= offered.length) return offered[index - 1];

    const tokens = tokenise(raw);
    const lower = raw.toLowerCase();
    const exact = offered.find((entry) => entry.name.toLowerCase() === lower);
    if (exact) return exact;

    const named = offered.filter((entry) => {
        const name = entry.name.toLowerCase();
        if (name.includes(lower)) return true;
        return tokens.length > 0 && tokens.every((token) => name.includes(token));
    });
    if (named.length === 1) return named[0];
    return null;
}

export function suggestionText(entries) {
    const lines = ['Here are a few places I think you would like:', ''];
    (entries || []).forEach((entry, i) => {
        lines.push(`${i + 1}. ${entry.name}`);
        const loc = locationLine(entry);
        if (loc) lines.push(`   ${loc}`);
        if (entry.description) lines.push(`   ${entry.description}`);
    });
    lines.push('', 'Which restaurant would you like to book?');
    return lines.join('\n');
}

export function suggestionRows(entries) {
    return (entries || []).map((entry, i) => {
        const row = {
            id: `rest:${entry.id}`,
            title: clip(`${i + 1}. ${entry.name}`, WA_LIMITS.LIST_ROW_TITLE),
        };
        const loc = locationLine(entry);
        const description = [loc, entry.description].filter(Boolean).join(' · ');
        if (description) row.description = clip(description, WA_LIMITS.LIST_ROW_DESCRIPTION);
        return row;
    });
}

export function uniqueAreas(entries) {
    const seen = new Set();
    const areas = [];
    for (const entry of entries || []) {
        const area = String(entry.area || '').trim();
        if (!area) continue;
        const key = area.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        areas.push(area);
    }
    return areas.sort((a, b) => a.localeCompare(b));
}

function areaSlug(area) {
    return String(area || '')
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-|-$/g, '');
}

/** Body + list rows when the guest has not named a known area. */
export function coverageText(entries) {
    const areas = uniqueAreas(entries);
    if (areas.length) {
        return [
            'We can book restaurants in these areas:',
            '',
            ...areas.slice(0, 10).map((area) => `• ${area}`),
            '',
            'Pick an area or a restaurant below, or type a city name.',
        ].join('\n');
    }
    return 'Here are restaurants we can book. Pick one below, or type a city if you know it.';
}

export function coverageRows(entries, { max = WA_LIMITS.MAX_LIST_ROWS } = {}) {
    const areas = uniqueAreas(entries);
    const areaRows = areas.slice(0, max).map((area) => ({
        id: `area:${areaSlug(area)}`,
        title: clip(area, WA_LIMITS.LIST_ROW_TITLE),
        description: 'Area',
    }));
    const remaining = max - areaRows.length;
    const restos = remaining > 0 ? (entries || []).slice(0, remaining) : [];
    return [...areaRows, ...suggestionRows(restos)];
}

/**
 * @param {Object} deps
 * @param {Function} deps.listTenants    tenantService.listTenants
 * @param {Function} deps.getTenantById  tenantService.getTenantById
 * @param {Function} [deps.fetchImpl]
 * @param {Function} [deps.now]
 */
export function createRestaurantDirectory({ listTenants, getTenantById, fetchImpl = fetch, now = () => Date.now() }) {
    let cache = null;

    async function fetchAddress(restaurantId) {
        try {
            const response = await fetchImpl(`${RESERVATION_API_BASE}/${encodeURIComponent(restaurantId)}/address`, {
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            if (!response.ok) return null;
            const data = await response.json();
            return data && (data.street_address || data.city) ? data : null;
        } catch (error) {
            logger.warn(`⚠️ [WhatsApp] Address lookup failed for restaurant ${restaurantId}: ${error.message}`);
            return null;
        }
    }

    async function load() {
        const tenants = (await listTenants()).filter((t) => t.isActive !== false);
        const entries = await Promise.all(tenants.map(async (summary) => {
            const [tenant, address] = await Promise.all([
                getTenantById(String(summary.restaurantId)),
                fetchAddress(summary.restaurantId),
            ]);
            if (!tenant || tenant.isActive === false) return null;
            return toDirectoryEntry(tenant, address);
        }));
        return entries.filter(Boolean);
    }

    async function list() {
        if (cache && now() - cache.at < CACHE_MS) return cache.entries;
        try {
            const entries = await load();
            cache = { at: now(), entries };
            return entries;
        } catch (error) {
            logger.error(`❌ [WhatsApp] Loading restaurants failed: ${error.message}`);
            if (cache) return cache.entries;
            throw error;
        }
    }

    return {
        list,

        async getById(id) {
            const wanted = String(id || '');
            if (!wanted || isHostRestaurantId(wanted)) return null;
            const entries = await list();
            return entries.find((entry) => entry.id === wanted) || null;
        },

        async suggest(location, { limit = SUGGESTION_LIMIT } = {}) {
            const entries = await list();
            return matchRestaurants(entries, location, { limit });
        },
    };
}
