// src/services/whatsapp/whatsappAvailability.js
// =============================================================================
// WHATSAPP — times to offer for a date
// =============================================================================
// Builds the time list from the same Mybooki API the dashboard Availability
// page configures (holidays + operating-hours shifts). If that API is
// unreachable, falls back to the tenant's Firestore operatingHours, then to
// 12:00–22:00. These are only suggestions: the chosen time is always checked
// with check-availability (capacityService) before booking.
// =============================================================================

import logger from '../../utils/logger.js';
import { isSheetImportedRestaurantId } from '../sheetRestaurantIds.js';
import { normaliseTime } from '../restaurantAvailabilityService.js';
import { buildTimeSlots, dayNameFor, hmToMinutes } from './whatsappDateTime.js';

const RESERVATION_API_BASE = 'https://mybookiapis.booki.co.za/restaurants';
const REQUEST_TIMEOUT_MS = 4000;
const LEAD_MINUTES = 30;
const MAX_TIMES = 9;
const DEFAULT_WINDOWS = [{ open: '12:00', close: '22:00' }];
const SHIFTS = ['breakfast', 'lunch', 'dinner'];

/** "18:00:00" | "6:00 PM" | "18:00" → "HH:mm" */
export function toHm(value) {
    if (!value) return null;
    const text = String(value).trim();
    const withSeconds = text.match(/^(\d{1,2}):(\d{2}):\d{2}$/);
    if (withSeconds) return normaliseTime(`${withSeconds[1]}:${withSeconds[2]}`);
    return normaliseTime(text);
}

/**
 * @returns {{closed: boolean, reason?: string|null, windows?: Array}|null}
 *          null = no usable data for that day
 */
export function windowsFromApi(holidays, hours, date) {
    const holiday = (Array.isArray(holidays) ? holidays : [])
        .find((h) => h?.date === date && h?.is_closed !== false);
    if (holiday) return { closed: true, reason: `closed for ${holiday.name}` };

    const day = hours?.schedule?.[dayNameFor(date)];
    if (!day) return null;
    if (day.is_closed) return { closed: true, reason: null };

    const windows = SHIFTS
        .filter((shift) => day[shift]?.enabled)
        .map((shift) => ({ open: toHm(day[shift].open_time), close: toHm(day[shift].close_time) }))
        .filter((w) => w.open && w.close);
    return windows.length > 0 ? { closed: false, windows } : { closed: true, reason: null };
}

export function windowsFromTenant(operatingHours, date) {
    const day = operatingHours?.[dayNameFor(date)];
    if (!day) return null;
    if (/closed/i.test(String(day.open || '')) || /closed/i.test(String(day.close || ''))) {
        return { closed: true, reason: null };
    }
    const open = toHm(day.open);
    const close = toHm(day.close);
    return open && close ? { closed: false, windows: [{ open, close }] } : null;
}

export function timeInWindows(windows, time) {
    const minutes = hmToMinutes(time);
    if (!Number.isFinite(minutes)) return false;
    return (windows || []).some((window) => {
        const open = hmToMinutes(window.open);
        const close = hmToMinutes(window.close);
        if (!Number.isFinite(open) || !Number.isFinite(close)) return false;
        if (close > open) return minutes >= open && minutes < close;
        return minutes >= open || minutes < close;
    });
}

/** Hours check for sheet-imported restaurants (no Mybooki sittings). */
export function evaluateHoursForTime(operatingHours, date, time) {
    const plan = windowsFromTenant(operatingHours, date) || { closed: false, windows: DEFAULT_WINDOWS };
    if (plan.closed) return { ok: false, reason: 'closed', message: plan.reason || 'Closed that day' };
    if (!time) return { ok: true, sittingId: null };
    if (!timeInWindows(plan.windows, time)) {
        return { ok: false, reason: 'closed', message: 'That time is outside opening hours' };
    }
    return { ok: true, sittingId: null };
}

function hoursPlanForDay(restaurant, date) {
    return windowsFromTenant(restaurant?.operatingHours, date) || { closed: false, windows: DEFAULT_WINDOWS };
}

export function createAvailabilityProvider({ fetchImpl = fetch } = {}) {
    async function fetchJson(url) {
        const response = await fetchImpl(url, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    }

    return {
        /**
         * @param {Object} restaurant  { id, operatingHours }
         * @param {string} date        YYYY-MM-DD
         * @param {{today: string, minutesNow: number}} now
         * @returns {Promise<{closed: boolean, reason: string|null, times: string[]}>}
         */
        async getDaySlots(restaurant, date, { today, minutesNow }) {
            let plan = null;
            if (isSheetImportedRestaurantId(restaurant?.id)) {
                plan = hoursPlanForDay(restaurant, date);
            } else {
                try {
                    const base = `${RESERVATION_API_BASE}/${restaurant.id}`;
                    const [holidays, hours] = await Promise.all([
                        fetchJson(`${base}/holidays`),
                        fetchJson(`${base}/operating-hours`),
                    ]);
                    plan = windowsFromApi(holidays, hours, date);
                } catch (error) {
                    logger.warn(`⚠️ [WhatsApp] Hours lookup failed for ${restaurant.id} ${date}: ${error.message} — using tenant hours`);
                }
                if (!plan) plan = windowsFromTenant(restaurant.operatingHours, date);
                if (!plan) plan = { closed: false, windows: DEFAULT_WINDOWS };
            }
            if (plan.closed) return { closed: true, reason: plan.reason || null, times: [] };

            const notBeforeMinutes = date === today ? minutesNow + LEAD_MINUTES : 0;
            return {
                closed: false,
                reason: null,
                times: buildTimeSlots(plan.windows, { notBeforeMinutes, max: MAX_TIMES }),
            };
        },
    };
}
