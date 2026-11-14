// Phone numbers and marketing consent words. Marketing never treats a bare
// booking contact as opted in.

const OPT_IN_VALUES = new Set(['yes', 'y', 'true', '1', 'opted_in', 'opt-in', 'optin']);
const OPT_OUT_PHRASES = new Set([
    'stop',
    'unsubscribe',
    'stop all',
    'stop promotions',
    'stop marketing',
    'opt out',
    'opt-out',
    'optout',
]);

export function normalizePhone(input, defaultCountryCode = '27') {
    if (input == null) return { ok: false, reason: 'missing' };
    const raw = String(input).trim();
    if (!raw) return { ok: false, reason: 'missing' };
    const code = String(defaultCountryCode || '27').replace(/\D/g, '') || '27';
    let digits = raw.replace(/\D/g, '');
    if (!digits) return { ok: false, reason: 'invalid' };
    if (raw.startsWith('00')) digits = digits.slice(2);
    if (!raw.startsWith('+') && digits.startsWith('0')) digits = `${code}${digits.slice(1)}`;
    if (digits.length < 8 || digits.length > 15) return { ok: false, reason: 'invalid' };
    return { ok: true, e164: `+${digits}`, digits };
}

export function isExplicitOptIn(value) {
    return OPT_IN_VALUES.has(String(value ?? '').trim().toLowerCase());
}

export function isOptOutText(text) {
    const normalized = String(text || '').trim().toLowerCase().replace(/[.!]+$/g, '');
    return OPT_OUT_PHRASES.has(normalized);
}

export function contactDocId(restaurantId, digits) {
    return `${restaurantId}_${digits}`;
}

export function suppressionDocId(restaurantId, digits) {
    return `${restaurantId}_${digits}`;
}

export function recipientDocId(campaignId, digits) {
    return `${campaignId}_${digits}`;
}

export function conversationDocId(restaurantId, digits) {
    return `${restaurantId}_${digits}`;
}
