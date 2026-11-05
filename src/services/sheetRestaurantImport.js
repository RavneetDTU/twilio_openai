// Idempotent Google Sheet → Firestore tenants import.
// Does not overwrite the original dashboard tenants (no importKey).
// Does not invent deposit, capacity, or missing contact fields.

import { createHash } from 'crypto';
import { db } from '../config/firebase.js';
import logger from '../utils/logger.js';

export const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/1mfaFUUBVdHHgZeXWJvfO9r9YJSTlyub0XSSHUHxXkHE/export?format=csv';
export const IMPORT_SOURCE = 'google_sheet';

const DAY_INDEX = { mo: 0, tu: 1, we: 2, th: 3, fr: 4, sa: 5, su: 6 };
const DAY_NAME = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    const src = String(text || '').replace(/^\uFEFF/, '');
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (inQuotes) {
            if (ch === '"') {
                if (src[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += ch;
        } else if (ch === '"') inQuotes = true;
        else if (ch === ',') { row.push(field); field = ''; }
        else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (ch !== '\r') field += ch;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((cell) => String(cell || '').trim()));
}

export function csvToObjects(text) {
    const rows = parseCsv(text);
    if (!rows.length) return [];
    const headers = rows[0].map((h) => String(h || '').trim());
    return rows.slice(1).map((cells, index) => {
        const record = { _row: index + 2 };
        headers.forEach((header, i) => { record[header] = String(cells[i] || '').trim(); });
        return record;
    });
}

export function normalisePhone(raw) {
    const digits = String(raw || '').replace(/[^\d+]/g, '');
    if (!digits) return '';
    if (digits.startsWith('+')) return digits.length >= 10 ? digits : '';
    if (digits.startsWith('00')) return `+${digits.slice(2)}`;
    if (digits.startsWith('27') && digits.length >= 11) return `+${digits}`;
    if (digits.startsWith('0') && digits.length === 10) return `+27${digits.slice(1)}`;
    if (digits.length === 9) return `+27${digits}`;
    return digits.length >= 8 ? `+${digits}` : '';
}

export function parsePhones(value) {
    const unique = [];
    const seen = new Set();
    for (const part of String(value || '').split(/[;,/]/)) {
        const phone = normalisePhone(part);
        if (!phone || seen.has(phone)) continue;
        seen.add(phone);
        unique.push(phone);
    }
    return unique;
}

export function to24HourRange(range) {
    const match = String(range || '').trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const openMin = Number(match[1]) * 60 + Number(match[2]);
    let closeMin = Number(match[3]) * 60 + Number(match[4]);
    if (closeMin === 0 && openMin > 0) closeMin = 24 * 60;
    return { openMin, closeMin };
}

export function formatHour12(totalMinutes) {
    const minutes = Math.max(0, Math.min(24 * 60, Number(totalMinutes) || 0));
    if (minutes >= 24 * 60) return '11:59 PM';
    const hour24 = Math.floor(minutes / 60) % 24;
    const min = minutes % 60;
    const suffix = hour24 >= 12 ? 'PM' : 'AM';
    const hour12 = hour24 % 12 || 12;
    return `${hour12}:${String(min).padStart(2, '0')} ${suffix}`;
}

function expandDayToken(token) {
    const value = String(token || '').trim().toLowerCase();
    if (!value || value === 'ph') return [];
    const range = value.match(/^([a-z]{2})\s*-\s*([a-z]{2})$/);
    if (range) {
        const start = DAY_INDEX[range[1]];
        const end = DAY_INDEX[range[2]];
        if (start === undefined || end === undefined) return [];
        const days = [];
        let i = start;
        while (true) {
            days.push(i);
            if (i === end) break;
            i = (i + 1) % 7;
        }
        return days;
    }
    if (DAY_INDEX[value] !== undefined) return [DAY_INDEX[value]];
    return [];
}

function parseDayList(list) {
    const days = new Set();
    for (const token of String(list || '').split(/[,\s]+/)) {
        for (const day of expandDayToken(token)) days.add(day);
    }
    return [...days];
}

/** Sheet hours → tenant operatingHours. Unparsed strings are kept as raw only. */
export function parseOperatingHours(raw) {
    const text = String(raw || '').trim();
    if (!text) return { hours: null, raw: '' };
    if (/^24\/7$/i.test(text)) {
        const allDay = { open: '12:00 AM', close: '11:59 PM' };
        const hours = {};
        for (const name of DAY_NAME) hours[name] = { ...allDay };
        return { hours, raw: text };
    }

    const hours = {};
    const chunks = text.split(';').map((part) => part.trim()).filter(Boolean);
    for (const chunk of chunks) {
        if (/\boff\b/i.test(chunk) && !/\d{1,2}:\d{2}/.test(chunk)) continue;
        const match = chunk.match(/^(.+?)\s+(\d{1,2}:\d{2}(?:\s*-\s*\d{1,2}:\d{2})(?:,\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})*)$/);
        const fallback = chunk.match(/^(\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})$/);
        let days;
        let ranges;
        if (match) {
            days = parseDayList(match[1]);
            ranges = match[2].split(',').map((item) => to24HourRange(item)).filter(Boolean);
        } else if (fallback) {
            days = [0, 1, 2, 3, 4, 5, 6];
            ranges = [to24HourRange(fallback[1])].filter(Boolean);
        } else {
            continue;
        }
        if (!days.length || !ranges.length) continue;
        const openMin = Math.min(...ranges.map((r) => r.openMin));
        const closeMin = Math.max(...ranges.map((r) => r.closeMin));
        for (const day of days) {
            hours[DAY_NAME[day]] = { open: formatHour12(openMin), close: formatHour12(closeMin) };
        }
    }

    return { hours: Object.keys(hours).length ? hours : null, raw: text };
}

export function venueTypeFrom(type, cuisine) {
    const kind = String(type || '').trim().toLowerCase();
    const food = String(cuisine || '').toLowerCase();
    if (food.includes('steak')) return 'steakhouse';
    if (food.includes('wine')) return 'wine bar';
    if (kind === 'cafe' || kind === 'fast_food' || kind === 'restaurant') return kind === 'fast_food' ? 'fast food' : kind;
    return kind || 'restaurant';
}

export function importKeyFor(name, city, primaryPhone) {
    return [name, city, primaryPhone]
        .map((value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' '))
        .join('|');
}

export function restaurantIdFor(importKey) {
    const digest = createHash('sha256').update(importKey).digest('hex').slice(0, 16);
    return `s_${digest}`;
}

function sanitisePhoneId(phone) {
    return String(phone || '').replace(/[^0-9+]/g, '');
}

export function mapSheetRow(record) {
    const name = String(record.Name || '').trim();
    const city = String(record.City || '').trim();
    const phones = parsePhones(record.Phone);
    const email = String(record.Email || '').trim().toLowerCase();
    const website = String(record.Website || '').trim();
    const street = String(record['Address'] || record['Address '] || '').trim();
    const cuisine = String(record.Cuisine || '').trim();
    const type = String(record.Type || '').trim();
    const hoursParsed = parseOperatingHours(record['Opening Hours']);

    const errors = [];
    if (!name) errors.push('missing name');
    if (!phones.length) errors.push('missing phone');
    if (!email || !email.includes('@')) errors.push('missing email');

    const importKey = importKeyFor(name, city, phones[0] || '');
    return {
        row: record._row,
        name,
        city,
        phones,
        email,
        website,
        street,
        cuisine,
        type,
        venueType: venueTypeFrom(type, cuisine),
        operatingHours: hoursParsed.hours,
        openingHoursRaw: hoursParsed.raw,
        importKey,
        restaurantId: restaurantIdFor(importKey),
        errors,
    };
}

function tenantPayload(mapped) {
    const directory = {
        city: mapped.city || '',
        street_address: mapped.street || '',
        province: '',
        website: mapped.website || '',
        cuisine: mapped.cuisine || '',
        venueTypeFromSheet: mapped.type || '',
        openingHoursRaw: mapped.openingHoursRaw || '',
        source: IMPORT_SOURCE,
    };
    const payload = {
        name: mapped.name,
        phoneNumbers: mapped.phones,
        model: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1',
        voice: 'marin',
        temperature: 0.8,
        venueType: mapped.venueType,
        isActive: true,
        settings: {
            depositAmount: 0,
            currency: 'rand',
            timezone: 'Africa/Johannesburg',
            RestaurantEmail: mapped.email,
            totalCapacity: 0,
            otherBookingsByDate: {},
            importKey: mapped.importKey,
            importSource: IMPORT_SOURCE,
            capacityUnknown: true,
        },
        directory,
        updatedAt: new Date(),
    };
    if (mapped.operatingHours) payload.operatingHours = mapped.operatingHours;
    return payload;
}

function namesMatch(a, b) {
    return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

/**
 * @param {Object} opts
 * @param {string} [opts.csv]
 * @param {boolean} [opts.apply]
 */
export async function importSheetRestaurants({ csv, apply = false } = {}) {
    const text = csv || await (await fetch(SHEET_CSV_URL)).text();
    if (/accounts\.google\.com|Sign in/i.test(text) && !text.includes('Name,City')) {
        throw new Error('SHEET_ACCESS: Google Sheet is not publicly readable as CSV');
    }

    const records = csvToObjects(text);
    const mapped = records.map(mapSheetRow);
    const rejected = mapped.filter((row) => row.errors.length);
    const accepted = mapped.filter((row) => !row.errors.length);

    const snap = await db.collection('tenants').get();
    const existing = [];
    snap.forEach((doc) => existing.push({ restaurantId: doc.id, ...doc.data() }));

    const protectedIds = new Set(existing.filter((t) => t.settings?.importSource !== IMPORT_SOURCE).map((t) => String(t.restaurantId)));
    const byImportKey = new Map(existing.filter((t) => t.settings?.importKey).map((t) => [t.settings.importKey, t]));
    const byId = new Map(existing.map((t) => [String(t.restaurantId), t]));

    const phoneOwner = new Map();
    const phoneSnap = await db.collection('phoneIndex').get();
    phoneSnap.forEach((doc) => {
        const restaurantId = doc.data()?.restaurantId;
        if (restaurantId) phoneOwner.set(doc.id, String(restaurantId));
    });

    const plan = [];
    const skipped = [...rejected.map((row) => ({ row: row.row, name: row.name, reason: row.errors.join(', ') }))];

    for (const row of accepted) {
        const protectedHit = existing.find((t) => protectedIds.has(String(t.restaurantId)) && namesMatch(t.name, row.name));
        if (protectedHit) {
            skipped.push({ row: row.row, name: row.name, reason: `matches existing tenant ${protectedHit.restaurantId}; left unchanged` });
            continue;
        }
        if (protectedIds.has(row.restaurantId)) {
            skipped.push({ row: row.row, name: row.name, reason: `generated id ${row.restaurantId} is a protected tenant` });
            continue;
        }

        const current = byImportKey.get(row.importKey) || byId.get(row.restaurantId);
        const action = current ? 'update' : 'create';
        plan.push({ action, row: row.row, restaurantId: current?.restaurantId || row.restaurantId, name: row.name, city: row.city, phones: row.phones, mapped: row });
    }

    const summary = {
        sourceRows: records.length,
        accepted: accepted.length,
        plannedCreates: plan.filter((p) => p.action === 'create').length,
        plannedUpdates: plan.filter((p) => p.action === 'update').length,
        skipped: skipped.length,
        existingBefore: existing.length,
        apply,
    };

    if (!apply) {
        return { ...summary, skipped, sample: plan.slice(0, 5).map(({ mapped, ...rest }) => rest) };
    }

    let created = 0;
    let updated = 0;
    for (const item of plan) {
        const payload = tenantPayload(item.mapped);
        const ref = db.collection('tenants').doc(item.restaurantId);
        if (item.action === 'create') {
            payload.createdAt = new Date();
            payload.questionFlow = [
                { id: `q_default_${item.restaurantId}_001`, title: 'Greeting', order: 1, botMessage: `Hello! Welcome to ${item.name}.`, isRequired: true, instructions: null },
            ];
            await ref.set(payload);
            created += 1;
        } else {
            const previous = byId.get(item.restaurantId) || {};
            await ref.set({
                ...payload,
                createdAt: previous.createdAt || new Date(),
                questionFlow: previous.questionFlow || payload.questionFlow,
            }, { merge: true });
            updated += 1;
        }

        for (const phone of item.phones) {
            const docId = sanitisePhoneId(phone);
            if (!docId) continue;
            const owner = phoneOwner.get(docId);
            if (owner && owner !== item.restaurantId && protectedIds.has(owner)) continue;
            await db.collection('phoneIndex').doc(docId).set({ restaurantId: item.restaurantId });
            phoneOwner.set(docId, item.restaurantId);
        }
        logger.info(`✅ Sheet import ${item.action}: ${item.name} (${item.restaurantId})`);
    }

    const after = await db.collection('tenants').get();
    return {
        ...summary,
        created,
        updated,
        existingAfter: after.size,
        skipped,
    };
}
