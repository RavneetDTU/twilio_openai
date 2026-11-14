import { contactDocId, normalizePhone, suppressionDocId } from './phone.js';

export function isSuppressed(suppression) {
    return Boolean(suppression && !suppression.liftedAt);
}

export function contactEligible(contact, suppression) {
    if (!contact?.optIn || contact.optOutAt) return { ok: false, reason: 'opted_out' };
    if (isSuppressed(suppression)) return { ok: false, reason: 'suppressed' };
    if (!contact.phoneE164 || !contact.phoneDigits) return { ok: false, reason: 'invalid_phone' };
    return { ok: true };
}

function inAudience(contact, audience) {
    const type = audience?.type || 'all';
    if (type === 'ids') return (audience.contactIds || []).includes(contact.id);
    if (type === 'tags') {
        const tags = audience.tags || [];
        return tags.length > 0 && (contact.tags || []).some((tag) => tags.includes(tag));
    }
    if (type === 'activity') {
        const last = contact.lastInteractionAt ? Date.parse(contact.lastInteractionAt) : null;
        const days = Number(audience.activeWithinDays);
        if (audience.inactive) {
            if (!last) return true;
            if (!Number.isFinite(days)) return false;
            return Date.now() - last > days * 86400000;
        }
        if (!last || !Number.isFinite(days)) return false;
        return Date.now() - last <= days * 86400000;
    }
    return true;
}

/**
 * Split a restaurant's contacts into people who can receive this campaign
 * and people who must be left out. Consent is required; a previous booking
 * is not consent.
 */
export function splitAudience(contacts, suppressions, audience, { defaultCountryCode = '27' } = {}) {
    const blocked = new Map((suppressions || []).map((row) => [row.phoneDigits, row]));
    const eligible = [];
    const excluded = [];

    for (const contact of contacts || []) {
        if (!inAudience(contact, audience)) {
            excluded.push({ contactId: contact.id, phone: contact.phoneE164, reason: 'not_in_audience' });
            continue;
        }
        const phone = normalizePhone(contact.phoneE164 || contact.phoneDigits, defaultCountryCode);
        const normalized = phone.ok
            ? { ...contact, phoneE164: phone.e164, phoneDigits: phone.digits }
            : contact;
        const decision = contactEligible(normalized, blocked.get(normalized.phoneDigits));
        if (!decision.ok) {
            excluded.push({ contactId: contact.id, phone: contact.phoneE164 || null, reason: decision.reason });
            continue;
        }
        eligible.push(normalized);
    }

    const tally = excluded.reduce((acc, row) => {
        acc[row.reason] = (acc[row.reason] || 0) + 1;
        return acc;
    }, {});

    return {
        eligible,
        excluded,
        summary: {
            selected: (contacts || []).filter((contact) => inAudience(contact, audience)).length,
            eligible: eligible.length,
            excluded: excluded.length,
            optedOut: (tally.opted_out || 0) + (tally.suppressed || 0),
            invalid: tally.invalid_phone || 0,
            notInAudience: tally.not_in_audience || 0,
        },
    };
}

export function suppressionFor(restaurantId, digits) {
    return suppressionDocId(restaurantId, digits);
}

export function sameContact(restaurantId, digits) {
    return contactDocId(restaurantId, digits);
}
