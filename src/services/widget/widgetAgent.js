// Universal website-widget booking agent.
// Restaurant facts, seats and the reservation itself come from the same
// services the WhatsApp channel uses. This file does not send WhatsApp messages.

import logger from '../../utils/logger.js';
import { getTenantById, listTenants } from '../tenantService.js';
import { getAvailableCapacityForDate } from '../capacityService.js';
import manualBookingService from '../manualBookingService.js';
import { createBookingAdapter } from '../whatsapp/whatsappBookingAdapter.js';
import { createAvailabilityProvider } from '../whatsapp/whatsappAvailability.js';
import {
    coverageText,
    createRestaurantDirectory,
    pickFromOffered,
    rankRecommendations,
    suggestionText,
} from '../whatsapp/whatsappRestaurantDirectory.js';
import {
    addDays,
    dateProblem,
    formatDateLong,
    formatTime12,
    hmToMinutes,
    MAX_ADVANCE_DAYS,
    minutesNowInTz,
    parseTimeInput,
    todayInTz,
} from '../whatsapp/whatsappDateTime.js';
import { validateName, validateRequests } from '../whatsapp/whatsappHandlers.js';
import { confirmationText, MAX_GUESTS } from '../whatsapp/whatsappSteps.js';
import smsService from '../smsService.js';

const MODEL = 'gpt-4o-mini';
const WELCOME = 'Hi! Welcome. I can help you discover restaurants, check availability and make a reservation. Which restaurant would you like to book?';
const MIN_LEAD_MINUTES = 30;

const availability = createAvailabilityProvider();
const directory = createRestaurantDirectory({ listTenants, getTenantById });
const RESULT_PAGE = 8;
const RESULT_KEEP = 40;
const slots = createBookingAdapter({
    getAvailableCapacityForDate,
    createManualBooking: (...args) => manualBookingService.createManualBooking(...args),
    paymentBaseUrl: smsService.paymentBaseUrl,
});

export function welcomeMessage() {
    return WELCOME;
}

export const WIDGET_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'find_restaurants',
            description: 'Search the same restaurant directory WhatsApp uses, by city, area, or restaurant name. Call this when the guest names a place or asks to find a restaurant.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'City, area, or restaurant name the guest said. Leave empty only to use their allowed browser area.' },
                    preference: { type: 'string' },
                    food: { type: 'string' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'more_restaurants',
            description: 'Show the next restaurants from the same area search. Call only after find_restaurants and only if the guest asks for more.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'select_restaurant',
            description: 'Choose one restaurant from the matches just returned. Pass its id.',
            parameters: {
                type: 'object',
                properties: { restaurant_id: { type: 'string' } },
                required: ['restaurant_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'remember_name',
            description: 'Save the guest name only after they have typed or said it themselves.',
            parameters: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'remember_phone',
            description: 'Save the phone number the moment the guest says or types it. Pass the digits you heard, without adding or repeating any.',
            parameters: {
                type: 'object',
                properties: { phone: { type: 'string' } },
                required: ['phone'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'check_availability',
            description: 'Check real seats for the selected restaurant. Call this before saying a time is available.',
            parameters: {
                type: 'object',
                properties: {
                    date: { type: 'string' },
                    time: { type: 'string' },
                    guests: { type: 'integer' },
                },
                required: ['date', 'time', 'guests'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'create_booking',
            description: 'Create the reservation after the guest confirms the recap. Do not tell them it is booked until this returns status booked.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    guests: { type: 'integer' },
                    date: { type: 'string' },
                    time: { type: 'string' },
                    phone: { type: 'string' },
                    special_requests: { type: 'string' },
                },
                required: ['name', 'guests', 'date', 'time', 'phone'],
            },
        },
    },
];

export function realtimeTools() {
    return WIDGET_TOOLS.map((tool) => ({
        type: 'function',
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
    }));
}

function calendar(today) {
    return Array.from({ length: 14 }, (_, i) => {
        const date = addDays(today, i);
        const label = i === 0 ? 'today' : i === 1 ? 'tomorrow' : formatDateLong(date);
        return `${label} = ${date}`;
    }).join('\n');
}

export function buildWidgetPrompt(state = {}) {
    const today = todayInTz(state.timezone || 'Africa/Johannesburg');
    const selected = state.restaurantName
        ? `Selected restaurant: ${state.restaurantName} (id ${state.restaurantId}). Use only this restaurant until the guest asks for a different one.`
        : 'No restaurant is selected. Do not assume Billy\'s Steakhouse or any other restaurant.';
    const offered = (state.offered || []).map((entry, i) => `${i + 1}. ${entry.name} [${entry.id}]`).join('\n');
    const areaHint = state.detectedArea
        ? `Browser area, only because the guest allowed location: ${state.detectedArea}. Use it when they have not named a place. If they name a different city or area, search that instead.`
        : 'No browser location. If they have not named a city or area, ask which area they would like.';
    return `You are Booki's website booking assistant. You help guests find a restaurant and reserve a table. You are not the host of one fixed restaurant.

Language
- Speak and write only in English.
- Greetings, suggestions, questions, confirmations and errors stay in English for the whole conversation.
- If the guest uses another language, say exactly: "I can help in English only." Then continue in English.

${selected}
${areaHint}
${state.guestName ? `The guest's name, given by them, is ${state.guestName}.` : 'You do not yet have the guest\'s name.'}
${offered ? `Restaurants just offered (the only ones you may name until a new search):\n${offered}` : ''}
${state.booking ? `A booking is already saved. Reference ${state.booking.paymentId}. Do not create it again.` : ''}

Today is ${formatDateLong(today)}.
${calendar(today)}

Rules
- Do not greet again. The opening greeting is already shown or spoken.
- If they want a restaurant but have not named a place or a restaurant, ask which city or area, unless a browser area is already known.
- Call find_restaurants for a city, area, or restaurant name. The tool returns the list. If the tool says say_exactly, your whole reply is that text. Do not shorten it to two names.
- Call more_restaurants only when they ask to see more from the same area.
- Call select_restaurant with an id from that list. After that, stay on that restaurant.
- Then collect guests, date, time, their name and a phone number. Skip anything they already gave.
- The moment the guest says their name, call remember_name with only the words they said. If they repeat or correct it, call remember_name again.
- The moment the guest says a phone number, call remember_phone with only those digits. A number starting with 0 is a South African local number. A 10-digit number that does not start with 0 is a mobile number: pass those 10 digits and do not add a country code or repeat digits. If they correct it, call remember_phone again.
- Keep guests, date and time exactly as they said them.
- Call check_availability before saying a time is free. If it is not, offer the alternatives the tool returned.
- Recap the restaurant, name, guests, date and time, and ask them to confirm.
- Call create_booking only after a clear yes. If it does not return booked, do not say the table is reserved.
- Short replies. One question at a time. No menus of made-up restaurants.`;
}

const NUMBER_WORDS = {
    zero: '0', oh: '0', o: '0', nought: '0', naught: '0',
    one: '1', two: '2', three: '3', four: '4', five: '5',
    six: '6', seven: '7', eight: '8', nine: '9',
};

function spokenDigits(text) {
    const words = String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
    let digits = '';
    for (let i = 0; i < words.length; i += 1) {
        const word = words[i];
        if (word === 'double' || word === 'triple') {
            const count = word === 'double' ? 2 : 3;
            const next = NUMBER_WORDS[words[i + 1]];
            if (next) {
                digits += next.repeat(count);
                i += 1;
            }
            continue;
        }
        if (NUMBER_WORDS[word]) digits += NUMBER_WORDS[word];
        else if (/^\d+$/.test(word)) digits += word;
    }
    return digits;
}

/** Keep only the name words that actually appear in what the guest said. */
export function nameFromGuest(candidate, texts) {
    const name = validateName(candidate);
    if (!name) return null;
    const blob = texts.join(' \n ').toLowerCase();
    if (!blob.trim()) return null;
    if (blob.includes(name.toLowerCase())) return name;
    const said = name.split(' ').filter((word) => word.length >= 2 && blob.includes(word.toLowerCase()));
    return said.length ? validateName(said.join(' ')) : null;
}

function digitRun(text) {
    const spoken = spokenDigits(text);
    const typed = String(text || '').replace(/\D/g, '');
    return spoken.length >= typed.length ? spoken : typed;
}

/** A number the guest actually said: local 0…, 9-digit ZA, 10-digit mobile, or +27 / +91 / +1. */
export function widgetPhone(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const international = raw.match(/\+\s*(\d[\d\s().-]{7,20})/);
    const digits = (international ? international[1] : digitRun(raw)).replace(/\D/g, '').replace(/^00/, '');
    if (digits.startsWith('27') && digits.length === 11) return `+${digits}`;
    if (digits.startsWith('91') && digits.length === 12) return `+${digits}`;
    if (digits.startsWith('1') && digits.length === 11 && digits[1] !== '0') return `+${digits}`;
    if (!international && digits.startsWith('0') && digits.length === 10) return `+27${digits.slice(1)}`;
    if (!international && digits.length === 9) return `+27${digits}`;
    if (!international && digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}`;
    if (!international && digits.length === 10 && /^[2-9]/.test(digits)) return `+1${digits}`;
    if (international && /^(44|61|971|33|49|31|353|64|65|81|86)/.test(digits) && digits.length >= 10 && digits.length <= 15) return `+${digits}`;
    return null;
}

function phoneFromLine(text) {
    const phrases = [
        /(?:phone|mobile|cell|contact)(?:\s+number|\s+no\.?)?\s*(?:is|:)?\s*([^\n.]{6,60})/i,
        /\bnumber\s*(?:is|:)\s*([^\n.]{6,60})/i,
    ];
    for (const pattern of phrases) {
        const match = String(text || '').match(pattern);
        const phone = match ? widgetPhone(match[1]) : null;
        if (phone) return phone;
    }
    return widgetPhone(text);
}

export function phoneFromGuest(candidate, texts) {
    const phone = widgetPhone(candidate);
    if (!phone) return null;
    const tail = phone.replace(/\D/g, '').slice(-8);
    const blobs = (texts || []).map((text) => `${String(text || '').replace(/\D/g, '')} ${spokenDigits(text)}`);
    return blobs.some((blob) => blob.includes(tail)) ? phone : null;
}

const NAME_PATTERNS = [
    /\bmy name is\s+([A-Za-z][A-Za-z'’.-]*(?:\s+[A-Za-z][A-Za-z'’.-]*){0,3})/i,
    /\bname is\s+([A-Za-z][A-Za-z'’.-]*(?:\s+[A-Za-z][A-Za-z'’.-]*){0,3})/i,
    /\bcall me\s+([A-Za-z][A-Za-z'’.-]*(?:\s+[A-Za-z][A-Za-z'’.-]*){0,2})/i,
    /\bbook(?:ing)? (?:it )?under\s+([A-Za-z][A-Za-z'’.-]*(?:\s+[A-Za-z][A-Za-z'’.-]*){0,2})/i,
];

/** Pull a name or phone the guest clearly said. Does not trust the assistant. */
export function detailsFromGuestLines(state, texts) {
    const next = { ...(state || {}) };
    let changed = false;
    const joined = (texts || []).map((text) => String(text || '')).filter(Boolean);
    for (const text of joined) {
        for (const pattern of NAME_PATTERNS) {
            const match = text.match(pattern);
            const name = match ? validateName(match[1].replace(/\b(and|for|please|thanks|thank you)\b.*$/i, '')) : null;
            if (name) {
                next.guestName = name;
                next.pendingName = null;
                changed = true;
            }
        }
        const phone = phoneFromLine(text);
        if (phone) {
            next.phone = phone;
            next.pendingPhone = null;
            changed = true;
        }
    }
    if (next.pendingName) {
        const confirmed = nameFromGuest(next.pendingName, joined);
        if (confirmed) {
            next.guestName = confirmed;
            next.pendingName = null;
            changed = true;
        }
    }
    if (next.pendingPhone) {
        const confirmed = phoneFromGuest(next.pendingPhone, joined);
        if (confirmed) {
            next.phone = confirmed;
            next.pendingPhone = null;
            changed = true;
        }
    }
    return { state: next, changed };
}

async function restaurantRecord(id) {
    const tenant = await getTenantById(String(id));
    if (!tenant || tenant.isActive === false) return null;
    return {
        id: String(tenant.restaurantId),
        name: tenant.name || `Restaurant ${tenant.restaurantId}`,
        timezone: tenant.settings?.timezone || 'Africa/Johannesburg',
        currency: tenant.settings?.currency || 'ZAR',
        depositAmount: Number(tenant.settings?.depositAmount) || 0,
        operatingHours: tenant.operatingHours || null,
    };
}

function checkDate(date, today) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return 'The date must be YYYY-MM-DD.';
    const problem = dateProblem(date, today);
    if (problem === 'past') return 'That date has already passed.';
    if (problem === 'too_far') return `Bookings are only taken up to ${MAX_ADVANCE_DAYS} days ahead.`;
    return null;
}

function checkTime(time, date, timezone) {
    const hm = parseTimeInput(time);
    if (!hm) return { error: 'The time must be a clock time such as 20:00.' };
    const today = todayInTz(timezone);
    if (date === today && hmToMinutes(hm) < minutesNowInTz(timezone) + MIN_LEAD_MINUTES) {
        return { error: 'That time is too soon or has already passed today.' };
    }
    return { hm };
}

function checkGuests(guests) {
    const n = Number(guests);
    if (!Number.isInteger(n) || n < 1) return { error: 'The number of guests must be at least 1.' };
    if (n > MAX_GUESTS) return { error: `Groups larger than ${MAX_GUESTS} need to contact the restaurant.` };
    return { n };
}

function snapshot(entries) {
    return entries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        area: entry.area || '',
        address: entry.address || '',
        cuisine: entry.cuisine || entry.description || '',
    }));
}

function listReply(page, area, more, continued) {
    const intro = continued
        ? (area ? `Here are more restaurants near ${area}.` : 'Here are more restaurants you can book.')
        : (area ? `Here are some restaurants near ${area} that you can book.` : 'Here are some restaurants you can book.');
    const close = more
        ? 'Say more restaurants if you would like the next ones.'
        : 'Tell me which one you would like to book.';
    return suggestionText(page, { intro, close });
}

async function runTool(name, args, state, visitorTexts, sessionId) {
    const next = { ...state, offered: state.offered || [] };
    if (name === 'find_restaurants') {
        const query = String(args.query || '').trim() || (!next.restaurantId ? String(next.detectedArea || '').trim() : '');
        if (!query) {
            return { state: next, result: { ask: 'Ask which city or area they would like, in English.' } };
        }
        if (args.preference) next.preference = String(args.preference);
        if (args.food) next.food = String(args.food);
        const found = await directory.suggest(query, { limit: RESULT_KEEP });
        if (!found.matches.length) {
            const coverage = coverageText(await directory.list());
            return { state: next, sayExactly: coverage, result: { say_exactly: coverage } };
        }
        const ranked = rankRecommendations(found.matches, {
            preference: next.preference,
            food: next.food,
            limit: RESULT_KEEP,
        });
        if (ranked.length === 1) {
            const record = await restaurantRecord(ranked[0].id);
            if (record) {
                next.restaurantId = record.id;
                next.restaurantName = record.name;
                next.timezone = record.timezone;
                next.offered = snapshot(ranked);
                next.locationMatches = snapshot(ranked);
                next.locationQuery = query;
                return { state: next, result: { selected: { id: record.id, name: record.name }, note: 'One restaurant matched. Continue the booking for this restaurant only.' } };
            }
        }
        next.locationQuery = query;
        next.locationMatches = snapshot(ranked);
        next.offerOffset = 0;
        const page = next.locationMatches.slice(0, RESULT_PAGE);
        next.offered = page;
        const text = listReply(page, query, next.locationMatches.length > RESULT_PAGE);
        return { state: next, sayExactly: text, result: { say_exactly: text, count: page.length, total: next.locationMatches.length } };
    }

    if (name === 'more_restaurants') {
        const matches = next.locationMatches || [];
        const start = Number(next.offerOffset || 0) + RESULT_PAGE;
        const page = matches.slice(start, start + RESULT_PAGE);
        if (!page.length) {
            return { state: next, result: { note: 'No further restaurants in this area. Ask for another city or area.' } };
        }
        next.offerOffset = start;
        next.offered = page;
        const text = listReply(page, next.locationQuery || '', start + RESULT_PAGE < matches.length, true);
        return { state: next, sayExactly: text, result: { say_exactly: text, count: page.length } };
    }

    if (name === 'select_restaurant') {
        const pool = [...(next.locationMatches || []), ...(next.offered || [])];
        const wanted = String(args.restaurant_id || '');
        const choice = pool.find((entry) => entry.id === wanted)
            || pickFromOffered({ type: 'text', text: wanted }, pool);
        const record = choice ? await restaurantRecord(choice.id) : null;
        if (!record) {
            return { state: next, result: { error: 'That restaurant is not in the list just shown. Ask them to choose a name or number from it.' } };
        }
        next.restaurantId = record.id;
        next.restaurantName = record.name;
        next.timezone = record.timezone;
        return { state: next, result: { selected: true, restaurant_id: record.id, name: record.name } };
    }

    if (name === 'remember_name') {
        const heardName = nameFromGuest(args.name, visitorTexts);
        if (heardName) {
            next.guestName = heardName;
            next.pendingName = null;
            return { state: next, result: { saved: true, name: heardName } };
        }
        const pending = validateName(args.name);
        if (pending) next.pendingName = pending;
        return { state: next, result: { saved: false, note: 'Ask them to say the name once more, slowly, then call remember_name with only those words.' } };
    }

    if (name === 'remember_phone') {
        const heardPhone = phoneFromGuest(args.phone, visitorTexts);
        if (heardPhone) {
            next.phone = heardPhone;
            next.pendingPhone = null;
            return { state: next, result: { saved: true, phone: heardPhone } };
        }
        const pending = widgetPhone(args.phone);
        if (pending) next.pendingPhone = pending;
        return { state: next, result: { saved: false, note: 'Ask them to repeat the phone number once, slowly, then call remember_phone with only those digits.' } };
    }

    if (!next.restaurantId) {
        return { state: next, result: { error: 'No restaurant is selected yet. Ask which restaurant, then search for it.' } };
    }
    const restaurant = await restaurantRecord(next.restaurantId);
    if (!restaurant) return { state: next, result: { error: 'That restaurant is no longer available.' } };
    const today = todayInTz(restaurant.timezone);

    if (name === 'check_availability') {
        const dateError = checkDate(args.date, today);
        if (dateError) return { state: next, result: { error: dateError } };
        const time = checkTime(args.time, args.date, restaurant.timezone);
        if (time.error) return { state: next, result: { error: time.error } };
        const guests = checkGuests(args.guests);
        if (guests.error) return { state: next, result: { error: guests.error } };
        const check = await slots.checkSlot(restaurant.id, args.date, time.hm, guests.n, restaurant);
        if (check.ok) {
            return { state: next, result: { available: true, restaurant: restaurant.name, date: args.date, time: time.hm, label: formatTime12(time.hm), guests: guests.n } };
        }
        const day = await availability.getDaySlots(restaurant, args.date, { today, minutesNow: minutesNowInTz(restaurant.timezone) });
        const alternatives = day.closed ? [] : await slots.findAlternatives(restaurant.id, args.date, time.hm, guests.n, day.times, restaurant);
        return {
            state: next,
            result: {
                available: false,
                reason: check.reason === 'closed' ? (check.message || 'closed') : 'fully booked',
                alternatives: alternatives.map((hm) => ({ time: hm, label: formatTime12(hm) })),
            },
        };
    }

    if (name === 'create_booking') {
        const name = nameFromGuest(args.name, visitorTexts) || (next.guestName && nameFromGuest(args.name, [next.guestName]) ? next.guestName : null);
        if (!name) {
            return { state: next, result: { error: 'Ask the guest to say the name for the booking, then call remember_name before creating it.' } };
        }
        const dateError = checkDate(args.date, today);
        if (dateError) return { state: next, result: { error: dateError } };
        const time = checkTime(args.time, args.date, restaurant.timezone);
        if (time.error) return { state: next, result: { error: time.error } };
        const guests = checkGuests(args.guests);
        if (guests.error) return { state: next, result: { error: guests.error } };
        const phone = phoneFromGuest(args.phone, visitorTexts) || widgetPhone(next.phone);
        if (!phone) {
            return { state: next, result: { error: 'Ask for the phone number they want on the booking, and wait until you hear the digits.' } };
        }
        const requests = args.special_requests ? (validateRequests(args.special_requests) || '') : '';
        const same = next.booking && next.booking.date === args.date && next.booking.time === time.hm && Number(next.booking.guests) === guests.n;
        if (same) return { state: next, result: { status: 'already_booked', paymentId: next.booking.paymentId } };

        const check = await slots.checkSlot(restaurant.id, args.date, time.hm, guests.n, restaurant);
        if (!check.ok) return { state: next, result: { status: 'not_booked', reason: check.reason || 'unavailable' } };
        try {
            const created = await manualBookingService.createManualBooking(restaurant.id, {
                name,
                phoneNo: phone,
                guests: guests.n,
                date: args.date,
                time: time.hm,
                notes: requests || undefined,
            }, {
                source: 'widget',
                sittingId: check.sittingId ?? null,
                extraFields: { channel: 'widget', widgetSessionId: sessionId },
            });
            const bookingAmount = (Number(restaurant.depositAmount) || 0) * guests.n;
            const paymentLink = bookingAmount > 0 ? `${smsService.paymentBaseUrl}/payment/${created.paymentId}` : null;
            const booking = {
                paymentId: created.paymentId,
                restaurantId: restaurant.id,
                restaurantName: restaurant.name,
                name,
                phone,
                guests: guests.n,
                date: args.date,
                time: time.hm,
                requests,
                status: 'booked',
                bookingAmount,
                paymentLink,
            };
            next.guestName = name;
            next.phone = phone;
            next.booking = booking;
            const text = confirmationText(restaurant, { name, guests: guests.n, date: args.date, time: time.hm, requests }, { paymentId: created.paymentId, paymentLink, bookingAmount });
            return { state: next, result: { status: 'booked', paymentId: created.paymentId, confirmation: text }, confirmation: text };
        } catch (error) {
            logger.error(`Widget booking failed for ${restaurant.id}: ${error.message}`);
            return { state: next, result: { status: 'error', error: 'The booking system did not save the reservation. Apologise and ask them to try again.' } };
        }
    }

    return { state: next, result: { error: 'That action is not available.' } };
}

function visitorLines(events) {
    return (events || []).filter((event) => event.from === 'visitor').slice(-8).map((event) => event.text);
}

export async function handleWidgetTurn({ apiKey, state, events, text, sessionId }) {
    const history = (events || []).slice(-24).map((event) => ({
        role: event.from === 'visitor' ? 'user' : 'assistant',
        content: event.text,
    }));
    history.push({ role: 'user', content: text });
    const messages = [{ role: 'system', content: buildWidgetPrompt(state) }, ...history];
    let nextState = detailsFromGuestLines(state, [text]).state;
    let confirmation = '';
    let sayExactly = '';
    for (let step = 0; step < 5; step += 1) {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: MODEL, temperature: 0.4, tools: WIDGET_TOOLS, messages }),
        });
        if (!response.ok) {
            logger.error(`Widget agent error: ${(await response.text()).slice(0, 300)}`);
            const error = new Error('Chat response failed');
            error.status = 502;
            throw error;
        }
        const data = await response.json();
        const message = data?.choices?.[0]?.message;
        const calls = message?.tool_calls || [];
        if (!calls.length) {
            const spoken = confirmation || String(message?.content || '').trim();
            if (!spoken) {
                const error = new Error('Empty assistant response');
                error.status = 502;
                throw error;
            }
            return { reply: spoken, state: nextState };
        }
        messages.push(message);
        for (const call of calls) {
            let args = {};
            try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = {}; }
            const outcome = await runTool(call.function?.name, args, nextState, [...visitorLines(events), text], sessionId);
            nextState = outcome.state;
            if (outcome.confirmation) confirmation = outcome.confirmation;
            if (outcome.sayExactly) sayExactly = outcome.sayExactly;
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(outcome.result) });
        }
        if (sayExactly || confirmation) return { reply: sayExactly || confirmation, state: nextState };
    }
    return { reply: confirmation || 'Could you tell me a little more so I can help with the reservation?', state: nextState };
}

export async function runWidgetTool({ name, args, state, events, sessionId, heard }) {
    const texts = [...visitorLines(events), ...(Array.isArray(heard) ? heard : [])].map((text) => String(text || '')).filter(Boolean).slice(-12);
    const prepared = detailsFromGuestLines(state || {}, texts).state;
    return runTool(name, args || {}, prepared, texts, sessionId);
}

