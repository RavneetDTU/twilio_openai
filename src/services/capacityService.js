import logger from '../utils/logger.js';
import { normaliseTime } from './restaurantAvailabilityService.js';

const RESERVATION_API_BASE = 'https://mybookiapis.booki.co.za/restaurants';
const REQUEST_TIMEOUT_MS = 4000;

/**
 * Sitting capacity for a booking time.
 *
 * Source of truth: GET /restaurants/:id/check-availability?date=&time=
 * The API picks the sittings that cover that time (weekly slots, or the
 * date-specific schedule when one exists). Overlapping sittings all come
 * back in `matches`. Capacity is per sitting: seats left = sitting_capacity
 * − booked_guests. A null capacity means no limit.
 *
 * This does not use settings.totalCapacity or otherBookingsByDate.
 */

function seatsForMatch(raw) {
    const capacity = raw?.sitting_capacity == null ? null : Number(raw.sitting_capacity);
    const bookedGuests = Number(raw?.booked_guests) || 0;
    const closed = raw?.available === false;
    const unlimited = !closed && capacity == null;
    const seatsLeft = closed ? 0 : (unlimited ? null : Math.max(0, capacity - bookedGuests));
    return {
        sittingId: raw?.sitting_id ?? null,
        sittingName: raw?.sitting_name || null,
        sittingCapacity: capacity,
        bookedGuests,
        seatsLeft,
        unlimited,
    };
}

function matchesFromCheck(check) {
    if (Array.isArray(check?.matches) && check.matches.length > 0) {
        return check.matches.map(seatsForMatch);
    }
    if (check?.sitting_id != null || check?.sitting_name) {
        return [seatsForMatch(check)];
    }
    return [];
}

/**
 * Prefer the sitting the API selected (top-level sitting_id) when it can
 * hold the party. Otherwise the first match that can. Overlaps are not rejected.
 * @param {Array} matches
 * @param {number|null} partySize
 * @param {number|null} preferredId
 */
export function chooseSitting(matches, partySize, preferredId) {
    const fits = (match) => match.unlimited || (match.seatsLeft != null && match.seatsLeft >= partySize);
    const preferred = matches.find((match) => preferredId != null && String(match.sittingId) === String(preferredId));
    if (partySize == null) return preferred || matches[0] || null;
    if (preferred && fits(preferred)) return preferred;
    return matches.find(fits) || null;
}

function toHm(rawTime) {
    if (rawTime == null) return null;
    const text = String(rawTime).trim();
    return normaliseTime(text) || (/^\d{2}:\d{2}$/.test(text) ? text : null);
}

async function fetchCheckAvailability(restaurantId, dateStr, time) {
    const url = `${RESERVATION_API_BASE}/${restaurantId}/check-availability?date=${encodeURIComponent(dateStr)}&time=${encodeURIComponent(time)}`;
    const response = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    return response.json();
}

/**
 * @param {Object} _settings  unused — kept so existing tool call sites stay the same
 * @param {string} restaurantId
 * @param {string} dateStr    YYYY-MM-DD
 * @param {string} [timeStr]  booking time
 */
export async function getAvailableCapacityForDate(_settings, restaurantId, dateStr, timeStr) {
    const time = toHm(timeStr);
    const base = {
        date: dateStr,
        time,
        available: null,
        unlimited: false,
        fullyBooked: false,
        needsTime: false,
        checkFailed: false,
        isOpen: true,
        isHoliday: false,
        closedReason: null,
        sittingId: null,
        sittingName: null,
        sittingCapacity: null,
        bookedGuests: null,
        matches: [],
    };

    if (!restaurantId || !dateStr || !time) {
        logger.info(`📊 [Capacity] ${restaurantId} ${dateStr} → time missing, not a sitting check`);
        return { ...base, needsTime: true };
    }

    let check;
    try {
        check = await fetchCheckAvailability(restaurantId, dateStr, time);
    } catch (err) {
        logger.error(`❌ [Capacity] check-availability failed for ${restaurantId} ${dateStr} ${time}: ${err.message} — not blocking`);
        return { ...base, checkFailed: true, unlimited: true };
    }

    const matches = matchesFromCheck(check);
    // Top-level sitting_id is the sitting the API selected for this time.
    const selected = chooseSitting(matches, null, check.sitting_id);

    if (check.is_open === false || matches.length === 0) {
        logger.info(
            `📊 [Capacity] ${restaurantId} ${dateStr} ${time} → closed (${check.reason || 'no sitting'})`
        );
        return {
            ...base,
            isOpen: false,
            isHoliday: Boolean(check.is_holiday),
            closedReason: check.reason || 'That time is not inside a sitting',
            matches,
        };
    }

    const unlimited = Boolean(selected?.unlimited);
    const available = unlimited ? null : (selected?.seatsLeft ?? 0);

    logger.info(
        `📊 [Capacity] ${restaurantId} ${dateStr} ${time} → ${selected?.sittingName || 'sitting'} ` +
        `capacity ${selected?.sittingCapacity ?? 'none'} booked ${selected?.bookedGuests ?? 0} ` +
        `| matches ${matches.length} | seats left ${unlimited ? 'unlimited' : available}`
    );

    return {
        ...base,
        available,
        unlimited,
        fullyBooked: !unlimited && available === 0,
        isHoliday: Boolean(check.is_holiday),
        sittingId: selected?.sittingId ?? null,
        sittingName: selected?.sittingName ?? null,
        sittingCapacity: selected?.sittingCapacity ?? null,
        bookedGuests: selected?.bookedGuests ?? null,
        matches,
    };
}

/** Shape returned to the realtime tool. No restaurant-wide capacity fields. */
export function capacityToolOutput(capacity) {
    return {
        date: capacity.date,
        time: capacity.time,
        available: capacity.available,
        unlimited: capacity.unlimited,
        fullyBooked: capacity.fullyBooked,
        needsTime: capacity.needsTime,
        checkFailed: capacity.checkFailed,
        isOpen: capacity.isOpen,
        isHoliday: capacity.isHoliday,
        closedReason: capacity.closedReason,
        sittingId: capacity.sittingId,
        sittingName: capacity.sittingName,
        sittingCapacity: capacity.sittingCapacity,
        bookedGuests: capacity.bookedGuests,
        matches: capacity.matches,
    };
}

/**
 * Sitting to store on the reservation for this date/time/party.
 * Uses the same check-availability response. Returns null if the time
 * matches no sitting or the API could not be reached (booking is not blocked).
 */
export async function resolveSittingIdForReservation(restaurantId, dateStr, rawTime, _partySize) {
    const capacity = await getAvailableCapacityForDate(null, restaurantId, dateStr, rawTime);
    logger.info(
        `📊 [Capacity] Reservation sitting for ${restaurantId} ${dateStr} ${rawTime} party ${_partySize} → ${capacity.sittingId ?? 'none'}`
    );
    if (capacity.checkFailed || capacity.needsTime || !capacity.isOpen) return null;
    return capacity.sittingId ?? null;
}
