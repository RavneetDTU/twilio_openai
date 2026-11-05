// Pull booking details out of free-text WhatsApp messages so the assistant
// does not re-ask for facts the guest already gave.

import { addDays, dayNameFor, parseDateInput, parseTimeInput, WEEK_DAYS } from './whatsappDateTime.js';
import { normaliseTime } from '../restaurantAvailabilityService.js';

const FOOD_HINTS = [
    ['steak', 'steak'],
    ['seafood', 'seafood'],
    ['fish', 'seafood'],
    ['vegetarian', 'vegetarian'],
    ['vegan', 'vegetarian'],
    ['wine', 'wine'],
    ['sushi', 'sushi'],
    ['pizza', 'pizza'],
    ['burger', 'burger'],
    ['italian', 'italian'],
    ['indian', 'indian'],
    ['chinese', 'chinese'],
    ['thai', 'thai'],
    ['mexican', 'mexican'],
    ['fast food', 'fast food'],
    ['grill', 'grill'],
];

const PREFERENCE_HINTS = [
    ['romantic', 'romantic'],
    ['date night', 'date night'],
    ['relaxed', 'relaxed'],
    ['casual', 'casual'],
    ['lively', 'lively'],
    ['family', 'family'],
    ['business', 'business'],
    ['celebration', 'celebration'],
    ['birthday', 'celebration'],
];

const GREETING_ONLY = /^(hi+|h+e+l+o+|hey+|hallo|hiya|howzit|good (morning|afternoon|evening))[!.,?\s]*$/i;

export function isGreetingOnly(text) {
    return GREETING_ONLY.test(String(text || '').trim());
}

function hintFrom(text, pairs) {
    const lower = String(text || '').toLowerCase();
    for (const [needle, value] of pairs) {
        if (lower.includes(needle)) return value;
    }
    return null;
}

function extractGuests(text) {
    const raw = String(text || '');
    const patterns = [
        /\b(?:table\s+for|party\s+of|for)\s+(\d{1,2})\s*(?:people|persons?|guests?|pax)\b/i,
        /\b(\d{1,2})\s*(?:people|persons?|guests?|pax)\b/i,
        /\btable\s+for\s+(\d{1,2})\b/i,
    ];
    for (const pattern of patterns) {
        const match = raw.match(pattern);
        if (!match) continue;
        const guests = Number(match[1]);
        if (guests >= 1 && guests <= 30) return guests;
    }
    return null;
}

function extractTime(text) {
    const raw = String(text || '');
    const labelled = raw.match(/\b(?:at|@)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/i)
        || raw.match(/\b(?:at|@)\s+(\d{1,2}):(\d{2})\b/i);
    if (labelled) {
        const hm = normaliseTime(`${labelled[1]}${labelled[2] ? `:${labelled[2]}` : ''}${labelled[3] ? ` ${labelled[3]}` : ''}`);
        if (hm) return hm;
    }
    const meridiem = raw.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/i);
    if (meridiem) {
        const hm = normaliseTime(`${meridiem[1]}${meridiem[2] ? `:${meridiem[2]}` : ''} ${meridiem[3]}`);
        if (hm) return hm;
    }
    const clock = raw.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (clock) return parseTimeInput(`${clock[1]}:${clock[2]}`);
    return null;
}

function weekdayDate(text, today) {
    const match = String(text || '').toLowerCase().match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
    if (!match || !today) return null;
    const target = WEEK_DAYS.findIndex((day) => day.toLowerCase() === match[1]);
    if (target < 0) return null;
    const current = WEEK_DAYS.indexOf(dayNameFor(today));
    const delta = (target - current + 7) % 7;
    return addDays(today, delta);
}

function extractDate(text, today) {
    const raw = String(text || '');
    if (!today) return null;
    if (/\btomorrow\b/i.test(raw) || /\btmrw\b/i.test(raw)) return addDays(today, 1);
    if (/\btoday\b/i.test(raw)) return today;
    const fromWeekday = weekdayDate(raw, today);
    if (fromWeekday) return fromWeekday;
    const snippet = raw.match(/\b(\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?)\b/);
    if (snippet) return parseDateInput(snippet[1], today);
    const named = raw.match(/\b(\d{1,2}(?:st|nd|rd|th)?\s+[a-z]{3,9}(?:\s+\d{4})?)\b/i);
    if (named) return parseDateInput(named[1], today);
    return parseDateInput(raw, today);
}

function extractLocation(text) {
    const raw = String(text || '').replace(/\s+/g, ' ').trim();
    const inPhrase = raw.match(/\b(?:in|near|around|at)\s+([A-Za-z][A-Za-z\s'-]{1,40}?)(?:\s+(?:for|at|on|tomorrow|today|please)|[.,!?]|$)/i);
    if (inPhrase) {
        const location = inPhrase[1].replace(/\b(area|city|town)\b/gi, '').trim();
        if (location.length >= 2) return location;
    }
    return null;
}

function extractCorrection(text) {
    const raw = String(text || '');
    const guests = raw.match(/\b(?:actually|make it|change (?:it )?to|update (?:it )?to|rather)\s+(\d{1,2})\s*(?:people|persons?|guests?|pax)?\b/i);
    if (guests) {
        const n = Number(guests[1]);
        if (n >= 1 && n <= 30) return { guests: n };
    }
    return null;
}

/**
 * @param {string} text
 * @param {{today?: string}} [opts]
 */
export function extractBookingDetails(text, { today } = {}) {
    const raw = String(text || '').trim();
    const correction = extractCorrection(raw);
    const guests = correction?.guests || extractGuests(raw);
    return {
        guests: guests || null,
        date: extractDate(raw, today),
        time: extractTime(raw),
        location: extractLocation(raw),
        food: hintFrom(raw, FOOD_HINTS),
        preference: hintFrom(raw, PREFERENCE_HINTS),
        name: null,
        correction: Boolean(correction),
    };
}

export function applyExtract(session, extracted) {
    if (!extracted) return session || {};
    const data = { ...(session?.data || {}) };
    if (extracted.guests) data.guests = extracted.guests;
    if (extracted.date) data.date = extracted.date;
    if (extracted.time) data.time = extracted.time;
    if (extracted.name) data.name = extracted.name;
    const next = { ...(session || {}), data };
    if (extracted.preference) next.preference = extracted.preference;
    if (extracted.food) next.foodInterest = extracted.food;
    if (extracted.location) next.locationQuery = extracted.location;
    if (extracted.correction) next.lastCorrection = extracted.guests ? 'guests' : 'details';
    return next;
}

export function hasCollectedBits(extracted) {
    if (!extracted) return false;
    return Boolean(extracted.guests || extracted.date || extracted.time || extracted.location || extracted.food || extracted.preference || extracted.name);
}

export function isCompoundExtract(extracted) {
    if (!extracted) return false;
    return [extracted.guests, extracted.date, extracted.time, extracted.location].filter(Boolean).length >= 2;
}

export function collectedSummary(session) {
    const data = session?.data || {};
    const lines = [];
    if (session?.restaurantId && session.restaurantId !== 'booki') lines.push(`restaurantId=${session.restaurantId}`);
    if (session?.locationQuery) lines.push(`area=${session.locationQuery}`);
    if (session?.preference) lines.push(`preference=${session.preference}`);
    if (session?.foodInterest) lines.push(`food=${session.foodInterest}`);
    if (data.name) lines.push(`name=${data.name}`);
    if (data.guests) lines.push(`guests=${data.guests}`);
    if (data.date) lines.push(`date=${data.date}`);
    if (data.time) lines.push(`time=${data.time}`);
    if (data.requests) lines.push(`requests=${data.requests}`);
    return lines;
}
