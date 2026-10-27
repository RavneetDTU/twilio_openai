// src/services/whatsapp/whatsappDateTime.js
// Pure date/time helpers for the WhatsApp booking flow. Dates are
// "YYYY-MM-DD" strings in the restaurant's timezone; times are "HH:mm".

import { normaliseTime } from '../restaurantAvailabilityService.js';

export const WEEK_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const MAX_ADVANCE_DAYS = 180;

function pad(n) {
    return String(n).padStart(2, '0');
}

function toUtcDate(dateStr) {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
}

function fromUtcDate(date) {
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Today's date in the given timezone. */
export function todayInTz(timezone, now = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
}

/** Minutes since midnight in the given timezone. */
export function minutesNowInTz(timezone, now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
    return hour * 60 + minute;
}

export function addDays(dateStr, days) {
    const date = toUtcDate(dateStr);
    date.setUTCDate(date.getUTCDate() + days);
    return fromUtcDate(date);
}

export function dayNameFor(dateStr) {
    return WEEK_DAYS[toUtcDate(dateStr).getUTCDay()];
}

/** "Fri 30 Oct" */
export function formatDateShort(dateStr) {
    const date = toUtcDate(dateStr);
    return `${SHORT_DAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()].slice(0, 3)}`;
}

/** "Friday, 30 October 2026" */
export function formatDateLong(dateStr) {
    const date = toUtcDate(dateStr);
    return `${WEEK_DAYS[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** "19:30" → "7:30 PM" */
export function formatTime12(hm) {
    const [h, m] = String(hm).split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return String(hm);
    const suffix = h >= 12 ? 'PM' : 'AM';
    return `${h % 12 || 12}:${pad(m)} ${suffix}`;
}

export function hmToMinutes(hm) {
    const [h, m] = String(hm).split(':').map(Number);
    return h * 60 + m;
}

export function minutesToHm(minutes) {
    return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

function isRealDate(y, m, d) {
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function monthFromName(name) {
    const key = name.toLowerCase().slice(0, 3);
    const index = MONTHS.findIndex((month) => month.toLowerCase().startsWith(key));
    return index === -1 ? null : index + 1;
}

/**
 * Parses what a guest types: "today", "tomorrow", "2026-12-25", "25/12",
 * "25/12/2026", "25-12-26", "25 Dec", "Dec 25". Day-first, as used in South Africa.
 * A date without a year that has already passed this year rolls to next year.
 * @returns {string|null} YYYY-MM-DD
 */
export function parseDateInput(text, today) {
    const raw = String(text || '').trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
    if (!raw) return null;
    if (raw === 'today') return today;
    if (raw === 'tomorrow' || raw === 'tmrw') return addDays(today, 1);

    const thisYear = Number(today.slice(0, 4));
    let y = null;
    let m = null;
    let d = null;

    let match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) {
        [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    } else if ((match = raw.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/))) {
        d = Number(match[1]);
        m = Number(match[2]);
        if (match[3]) y = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
    } else if ((match = raw.match(/^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)\.?(?: (\d{4}))?$/))) {
        d = Number(match[1]);
        m = monthFromName(match[2]);
        if (match[3]) y = Number(match[3]);
    } else if ((match = raw.match(/^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/))) {
        m = monthFromName(match[1]);
        d = Number(match[2]);
        if (match[3]) y = Number(match[3]);
    } else {
        return null;
    }

    if (!m || !d) return null;
    const explicitYear = y != null;
    if (!explicitYear) y = thisYear;
    if (!isRealDate(y, m, d)) return null;

    let result = `${y}-${pad(m)}-${pad(d)}`;
    if (!explicitYear && result < today && isRealDate(y + 1, m, d)) {
        result = `${y + 1}-${pad(m)}-${pad(d)}`;
    }
    return result;
}

/** @returns {'past'|'too_far'|null} */
export function dateProblem(dateStr, today, maxAdvanceDays = MAX_ADVANCE_DAYS) {
    if (dateStr < today) return 'past';
    if (dateStr > addDays(today, maxAdvanceDays)) return 'too_far';
    return null;
}

/** Accepts "19:30", "7pm", "7:30 pm", "19h30", "1930". */
export function parseTimeInput(text) {
    const raw = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!raw) return null;
    const direct = normaliseTime(raw.replace(/^(\d{1,2})h(\d{2})$/, '$1:$2'));
    if (direct) return direct;
    const compact = raw.match(/^(\d{2})(\d{2})$/);
    if (compact) return normaliseTime(`${compact[1]}:${compact[2]}`);
    return null;
}

/** Next `count` days starting today, as list rows. */
export function upcomingDateRows(today, count = 10) {
    return Array.from({ length: count }, (_, i) => {
        const date = addDays(today, i);
        let description = dayNameFor(date);
        if (i === 0) description = 'Today';
        if (i === 1) description = 'Tomorrow';
        return { id: `date:${date}`, title: formatDateShort(date), description };
    });
}

/**
 * Booking start times inside the given windows.
 * Last start is an hour before close (or the open time for short windows).
 * Times earlier than `notBeforeMinutes` are dropped (used for today).
 * At most `max` times are returned, spread evenly across the day.
 * @param {Array<{open: string, close: string}>} windows  HH:mm
 */
export function buildTimeSlots(windows, { notBeforeMinutes = 0, max = 10 } = {}) {
    const collect = (step) => {
        const set = new Set();
        for (const window of windows) {
            const open = hmToMinutes(window.open);
            let close = hmToMinutes(window.close);
            if (Number.isNaN(open) || Number.isNaN(close)) continue;
            if (close <= open) close = 24 * 60 - 30;
            const lastStart = close - open >= 90 ? close - 60 : open;
            const first = Math.ceil(open / 30) * 30;
            for (let t = first; t <= lastStart; t += step) {
                if (t >= notBeforeMinutes) set.add(t);
            }
        }
        return [...set].sort((a, b) => a - b);
    };

    let slots = collect(30);
    if (slots.length > max) slots = collect(60);
    if (slots.length > max) {
        const picked = [];
        for (let i = 0; i < max; i++) {
            picked.push(slots[Math.round((i * (slots.length - 1)) / (max - 1))]);
        }
        slots = [...new Set(picked)];
    }
    return slots.map(minutesToHm);
}
