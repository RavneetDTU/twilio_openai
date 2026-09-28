// src/services/restaurantAvailabilityService.js
// =============================================================================
// RESTAURANT AVAILABILITY — weekly shifts (breakfast/lunch/dinner) + holidays
// =============================================================================
// Source of truth: Mybooki API (mybookiapis.booki.co.za), configured per
// restaurant from the mybooki dashboard (Availability page).
//
// Feature flag: RESTAURANT_AVAILABILITY_CHECK_ENABLED=true (default off).
//
// Fail-open by design: if the API is unreachable, slow, or the restaurant has
// not configured hours for that day, the booking is NOT blocked — the call
// behaves exactly as it did before this feature existed.
// =============================================================================

import logger from '../utils/logger.js';

const RESERVATION_API_BASE = 'https://mybookiapis.booki.co.za/restaurants';
const REQUEST_TIMEOUT_MS = 4000;

const WEEK_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Read at call time — ESM imports run before dotenv.config() in server.js. */
export function isAvailabilityCheckEnabled() {
    return process.env.RESTAURANT_AVAILABILITY_CHECK_ENABLED === 'true';
}

/** Optional `time` property added to check_capacity_for_date when the flag is on. */
export const AVAILABILITY_TIME_PARAM = {
    type: 'string',
    description: 'The requested booking time in 24-hour HH:mm format (e.g. "19:00"). Always pass it once the caller has given a time.',
};

/** Appended to the system prompt when the flag is on. */
export const AVAILABILITY_PROMPT_RULES = `
📅 Opening Hours & Holidays Rule (CRITICAL — DO NOT IGNORE)
- When you call check_capacity_for_date, ALWAYS pass the booking time as "time" (24-hour HH:mm) once the caller has given a time.
- If the tool returns isOpen = false, you MUST NOT book. Politely explain using the "closedReason" (e.g. "I'm sorry, we're closed on that date for Christmas Day.") and offer a different date or time.
- If isHoliday = true, tell the caller the restaurant is closed that day for the holiday — do NOT say "fully booked".
- If the time is outside service hours, suggest a time within the "serviceHours" returned by the tool.
- Only proceed to confirmation when isOpen is not false AND seats are available.
`;

/**
 * Normalises "19:00", "7pm", "7:30 PM", "07:30" → "HH:mm". Returns null if unparseable.
 * @param {string} raw
 * @returns {string|null}
 */
export function normaliseTime(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const m = raw.trim().toLowerCase().match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/);
    if (!m) return null;

    let hours = Number(m[1]);
    const minutes = Number(m[2] ?? 0);
    const meridiem = m[3]?.replace(/\./g, '');

    if (meridiem === 'pm' && hours < 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
    if (hours > 23 || minutes > 59) return null;

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function dayNameFor(dateStr) {
    const [y, mo, d] = dateStr.split('-').map(Number);
    if (!y || !mo || !d) return null;
    return WEEK_DAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
}

async function fetchJson(url) {
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

function describeServiceHours(daySchedule) {
    return ['breakfast', 'lunch', 'dinner']
        .filter((s) => daySchedule?.[s]?.enabled)
        .map((s) => `${s} ${daySchedule[s].open_time}-${daySchedule[s].close_time}`);
}

/**
 * Checks holidays + weekly shifts for a booking date (and time, if known).
 *
 * @param {string} restaurantId
 * @param {string} dateStr   YYYY-MM-DD
 * @param {string} [rawTime] Any caller-style time; normalised to HH:mm
 * @returns {Promise<{
 *   checked: boolean,           // false → no data / error → do not block
 *   isOpen: boolean,
 *   isHoliday: boolean,
 *   closedReason: string|null,
 *   shift: string|null,
 *   serviceHours: string[],
 * }>}
 */
export async function checkRestaurantAvailability(restaurantId, dateStr, rawTime) {
    const allow = { checked: false, isOpen: true, isHoliday: false, closedReason: null, shift: null, serviceHours: [] };

    const dayName = dateStr ? dayNameFor(dateStr) : null;
    if (!restaurantId || !dayName) return allow;

    const time = normaliseTime(rawTime);
    const base = `${RESERVATION_API_BASE}/${restaurantId}`;

    try {
        const [holidays, hours, check] = await Promise.all([
            fetchJson(`${base}/holidays`),
            fetchJson(`${base}/operating-hours`),
            time
                ? fetchJson(`${base}/check-availability?date=${encodeURIComponent(dateStr)}&time=${encodeURIComponent(time)}`)
                : Promise.resolve(null),
        ]);

        const holiday = (Array.isArray(holidays) ? holidays : [])
            .find((h) => h?.date === dateStr && h?.is_closed !== false);
        if (holiday) {
            logger.info(`📅 [Availability] ${restaurantId} ${dateStr} → holiday "${holiday.name}"`);
            return { ...allow, checked: true, isOpen: false, isHoliday: true, closedReason: `Closed for ${holiday.name}` };
        }

        // Hours not configured for this day → the API would say "closed"; we do not block.
        const daySchedule = hours?.schedule?.[dayName];
        if (!daySchedule) {
            logger.info(`📅 [Availability] ${restaurantId} ${dateStr} → no operating hours configured for ${dayName}; not enforcing`);
            return allow;
        }

        const serviceHours = describeServiceHours(daySchedule);

        if (daySchedule.is_closed || serviceHours.length === 0) {
            logger.info(`📅 [Availability] ${restaurantId} ${dateStr} → closed on ${dayName}`);
            return { ...allow, checked: true, isOpen: false, closedReason: `Closed on ${dayName}` };
        }

        if (check) {
            logger.info(
                `📅 [Availability] ${restaurantId} ${dateStr} ${time} → is_open=${check.is_open} shift=${check.shift || '-'} reason=${check.reason || '-'}`
            );
            return {
                checked: true,
                isOpen: check.is_open !== false,
                isHoliday: Boolean(check.is_holiday),
                closedReason: check.is_open === false ? (check.reason || 'Outside service hours') : null,
                shift: check.shift || null,
                serviceHours,
            };
        }

        logger.info(`📅 [Availability] ${restaurantId} ${dateStr} → open (${serviceHours.join(', ')}), time not given`);
        return { ...allow, checked: true, serviceHours };

    } catch (err) {
        logger.error(`❌ [Availability] Check failed for ${restaurantId} ${dateStr}: ${err.message} — not blocking booking`);
        return allow;
    }
}
