// src/services/whatsapp/whatsappAiAgent.js
// =============================================================================
// WHATSAPP — conversational booking agent (WA_CONVERSATION_MODE=ai, default)
// =============================================================================
// Free-text chat like a front-of-house host. The model only talks; every fact
// that matters goes through tools that reuse the guided flow's code:
//   get_available_times → whatsappAvailability.getDaySlots
//   check_availability  → booking.checkSlot (+ findAlternatives)
//   create_booking      → booking.book → existing createManualBooking
// Inputs are re-validated here (date, time, guests, name, phone). After a
// successful booking the confirmation + payment link is sent by code, never
// written by the model.
//
// handleAiMessage(input, session, ctx) → next session (or null to clear it)
// ctx.ai is an OpenAI client (chat.completions.create).
// =============================================================================

import logger from '../../utils/logger.js';
import { DEFAULT_TIMEZONE } from './whatsappConfig.js';
import {
    addDays,
    dateProblem,
    formatDateLong,
    formatDateShort,
    formatTime12,
    hmToMinutes,
    MAX_ADVANCE_DAYS,
    minutesNowInTz,
    parseTimeInput,
    todayInTz,
} from './whatsappDateTime.js';
import { normalisePhoneInput, validateName, validateRequests } from './whatsappHandlers.js';
import {
    HOST_RESTAURANT_ID,
    isHostRestaurantId,
    suggestionText,
} from './whatsappRestaurantDirectory.js';
import {
    beginRestaurantPick,
    coveragePromptForHistory,
    foodPromptForHistory,
    handleFoodReply,
    handleLocationReply,
    handlePreferenceReply,
    handleRestaurantReply,
    hasBookingRestaurant,
    isBookIntent,
    locationPromptForHistory,
    preferencePromptForHistory,
} from './whatsappRestaurantPicker.js';
import { toMillis } from './whatsappSessionStore.js';
import {
    cancelledText,
    chooseFromListText,
    confirmationText,
    formatMoney,
    LOCATION_PROMPT,
    MAX_GUESTS,
    noMatchText,
    selectedRestaurantText,
    sendWelcome,
    welcomeText,
} from './whatsappSteps.js';
import { applyExtract, collectedSummary, extractBookingDetails, hasCollectedBits, isGreetingOnly } from './whatsappExtract.js';

export const DEFAULT_AI_MODEL = 'gpt-4.1-mini';

const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY = 40;
const MAX_TOOL_ROUNDS = 5;
const MIN_LEAD_MINUTES = 30;
const CALENDAR_DAYS = 14;

const RESET_WORDS = new Set(['restart', 'start over', 'reset', 'menu']);
const CANCEL_WORDS = new Set(['cancel', 'cancel booking']);

export const PICK_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'find_restaurants',
            description: 'Finds restaurants in an area the guest named. Call when they say a neighbourhood, city or area and have not picked a restaurant yet. The system then asks preference and food in ordinary text, then sends a numbered list of real restaurants.',
            parameters: {
                type: 'object',
                properties: { location: { type: 'string', description: 'Area, neighbourhood or city' } },
                required: ['location'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'select_restaurant',
            description: 'Locks in a restaurant from the numbered list just shown. restaurant_id must be one of those ids. Also call this when they say option 2 or the restaurant name.',
            parameters: {
                type: 'object',
                properties: { restaurant_id: { type: 'string' } },
                required: ['restaurant_id'],
                additionalProperties: false,
            },
        },
    },
];

export const AI_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'get_available_times',
            description: 'Booking times the restaurant offers on a date (from opening hours). Call when the guest has a date but no time yet, or asks what times are free.',
            parameters: {
                type: 'object',
                properties: { date: { type: 'string', description: 'YYYY-MM-DD' } },
                required: ['date'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'check_availability',
            description: 'Checks seats for a party at a date and time. ALWAYS call before telling the guest a time is available. Returns alternatives when it is not.',
            parameters: {
                type: 'object',
                properties: {
                    date: { type: 'string', description: 'YYYY-MM-DD' },
                    time: { type: 'string', description: 'HH:mm, 24-hour' },
                    guests: { type: 'integer', minimum: 1 },
                },
                required: ['date', 'time', 'guests'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'create_booking',
            description: 'Creates the booking. Only call after you recapped the details and the guest clearly said yes. The system then sends the confirmation and payment link itself.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    guests: { type: 'integer', minimum: 1 },
                    date: { type: 'string', description: 'YYYY-MM-DD' },
                    time: { type: 'string', description: 'HH:mm, 24-hour' },
                    phone: { type: 'string', description: 'Contact number. Omit to use their WhatsApp number.' },
                    special_requests: { type: 'string', description: 'Allergies, occasion, seating. Empty if none.' },
                },
                required: ['name', 'guests', 'date', 'time'],
                additionalProperties: false,
            },
        },
    },
];

function timezoneOf(restaurant) {
    return restaurant.timezone || DEFAULT_TIMEZONE;
}

function calendarLines(today) {
    return Array.from({ length: CALENDAR_DAYS }, (_, i) => {
        const date = addDays(today, i);
        const label = i === 0 ? ' (today)' : i === 1 ? ' (tomorrow)' : '';
        return `- ${formatDateShort(date)} = ${date}${label}`;
    }).join('\n');
}

export function buildSystemPrompt({ restaurant, config, waId, knownName, now, session }) {
    const tz = timezoneOf(restaurant);
    const today = todayInTz(tz, now);
    const nowHm = minutesNowInTz(tz, now);
    const clock = formatTime12(`${String(Math.floor(nowHm / 60)).padStart(2, '0')}:${String(nowHm % 60).padStart(2, '0')}`);
    const deposit = Number(restaurant.depositAmount) || 0;

    const selected = restaurant && !isHostRestaurantId(restaurant.id);
    const known = collectedSummary(session);
    const offered = (session?.offeredRestaurants || []).map((entry, i) => `${i + 1}. ${entry.name} [${entry.id}]`).join('\n');
    const facts = selected ? [
        restaurant.city && `City: ${restaurant.city}`,
        restaurant.address && `Address: ${restaurant.address}`,
        restaurant.cuisine && `Cuisine: ${restaurant.cuisine}`,
        restaurant.phone && `Phone: ${restaurant.phone}`,
    ].filter(Boolean).join('\n') : '';

    return `You are the WhatsApp host for ${selected ? restaurant.name : 'Booki'}. You are a polite, professional restaurant booking assistant. You are not a form and you are not a human employee.

How you write
- Short WhatsApp messages: usually 1–3 sentences. Ask only one question per message.
- Sound warm and natural. Acknowledge what they just said, then ask only for the next missing fact.
- Do not greet again if you have already welcomed them. Do not repeat their name in every message.
- No chatbot menus, no "choose an option", no robotic labels like "Enter your preferred booking date".
- Numbered restaurant lists are allowed only when repeating a list the system already sent. Do not invent extra restaurants.
- Reply in the guest's language.

Never invent
- Restaurant names, addresses, hours, phone numbers, menus, prices, policies or specials.
- Availability, booking confirmations, payment confirmations or reference numbers.
- If you do not have a verified fact, say you do not have that confirmed and offer to check or share the contact details.

What you know
- Today is ${formatDateLong(today)}, about ${clock} (${tz}).
- Calendar for resolving dates like "Tuesday" or "3 Nov":
${calendarLines(today)}
- Bookings are taken up to ${MAX_ADVANCE_DAYS} days ahead, at least ${MIN_LEAD_MINUTES} minutes from now. Groups larger than ${MAX_GUESTS}: ask them to contact the restaurant.
- Deposit: ${deposit > 0 ? `${formatMoney(deposit, restaurant.currency)} per guest, paid through a secure link sent after booking` : 'none required'}.
- Menu: ${config.menuUrl || 'not available on WhatsApp'}.
- Contact details: ${config.contactInfo || 'not provided'}.
- The guest's WhatsApp number is +${waId}.${knownName ? `\n- Their name is probably ${knownName}. Offer it once, e.g. "Shall I put it under ${knownName.split(' ')[0]}?"` : ''}
${known.length ? `- Already collected (do not ask again unless they change it):\n${known.map((line) => `  - ${line}`).join('\n')}` : ''}
${offered ? `- Restaurants just offered (the only ones you may name until they pick):\n${offered}` : ''}
${facts ? `- Verified facts for ${restaurant.name}:\n${facts}` : ''}

${selected ? `Taking a booking at ${restaurant.name}` : `Choosing a restaurant
- The guest has not picked a restaurant yet. Do not guess one and never use a default restaurant.
- If they have not said an area, ask which area they would like to dine in.
- Once they name an area, call find_restaurants. The system sends preference, food and restaurant messages itself — do not repeat those lists.
- Call select_restaurant only with an id from the list just shown.
- If they do not name a known area, the system shows real areas we cover. Do not invent cities or restaurants.
- Do not call get_available_times, check_availability or create_booking until a restaurant is selected.

Taking a booking`}
- You need: name, number of guests, date and time. Use their WhatsApp number unless they give another. Ask once about allergies or a special occasion.
- If they give several details at once, keep all of them. If they say "actually, make it 6 guests", update that field only.
- Once you know the date, you may call get_available_times. Those times are opening-hour slots, not a confirmed table.
- Before saying a time can be booked, call check_availability with date, time and guests. Never claim a table is available without that tool. If it is not available, explain politely and offer returned alternatives.
- When everything is known and check_availability returned available, recap in one short message and ask them to confirm.
- Only call create_booking after a clear yes. Do not write a confirmation or a payment link yourself; the system sends them after the booking is saved.
- If a tool returns an error, explain it simply and ask for what is needed.

Other questions
- Answer only from verified facts above. If you don't know, say so and share the menu link or contact details.
- You cannot change or cancel existing bookings in this chat; give the contact details for that.`;
}

/** Keeps the last MAX_HISTORY messages, starting at a user message so tool calls stay paired. */
export function trimHistory(history, max = MAX_HISTORY) {
    if (history.length <= max) return history;
    let start = history.length - max;
    while (start < history.length && history[start].role !== 'user') start++;
    return history.slice(start);
}

export function inputToText(input) {
    if (input.type === 'text') return String(input.text || '').trim();
    if (input.type === 'reply') return String(input.title || input.id || '').trim();
    return `[The guest sent a ${input.kind || 'message'} that you cannot open. Politely ask them to type it instead.]`;
}

function newAiSession(ctx) {
    return {
        mode: 'ai',
        restaurantId: ctx.directory ? HOST_RESTAURANT_ID : ctx.restaurant.id,
        history: [],
        awaiting: null,
        offeredRestaurants: [],
    };
}

function isFresh(session, ctx) {
    if (!session || session.mode !== 'ai') return false;
    if (ctx.directory) {
        if (session.restaurantId !== ctx.restaurant.id && session.restaurantId !== HOST_RESTAURANT_ID) return false;
    } else if (session.restaurantId !== ctx.restaurant.id) {
        return false;
    }
    const updated = toMillis(session.updatedAt);
    return !updated || ctx.now.getTime() - updated <= SESSION_IDLE_MS;
}

function toolsFor(ctx, session) {
    if (ctx.directory && !hasBookingRestaurant(ctx, session)) return [...PICK_TOOLS, ...AI_TOOLS];
    return AI_TOOLS;
}

function remember(session, input, assistantText) {
    return {
        ...session,
        history: [
            ...(session.history || []),
            { role: 'user', content: inputToText(input) || '(empty message)' },
            { role: 'assistant', content: assistantText },
        ],
    };
}

function uniqueAreaLines(prompt) {
    return String(prompt || '')
        .split('\n')
        .map((line) => line.replace(/^\d+\.\s*/, '').trim())
        .filter((line) => line && !/tell me|don't have|i can help/i.test(line));
}

function leftoverLocation(input) {
    if (input?.type !== 'text') return '';
    const stripped = String(input.text || '')
        .replace(/\b(hi|hello|please|i want to|i'd like to|id like to|can i|book( a)? table|a table|book|reservation|table)\b/gi, ' ')
        .replace(/[!.,?]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return stripped.length >= 2 ? stripped : '';
}

async function handleRestaurantSelectionTurn(input, session, ctx) {
    if (session.awaiting === 'restaurant') {
        const next = await handleRestaurantReply(ctx, session, input);
        return remember(next, input, hasBookingRestaurant(ctx, next)
            ? selectedRestaurantText(ctx.restaurant.name, next.data || {})
            : chooseFromListText());
    }

    if (session.awaiting === 'food') {
        const next = await handleFoodReply(ctx, session, input);
        return remember(next, input, next.awaiting === 'restaurant'
            ? suggestionText(next.offeredRestaurants)
            : noMatchText());
    }

    if (session.awaiting === 'preference') {
        const next = await handlePreferenceReply(ctx, session, input);
        return remember(next, input, foodPromptForHistory());
    }

    if (session.awaiting === 'location') {
        if (isGreetingOnly(inputToText(input)) || (isBookIntent(input) && !leftoverLocation(input))) {
            return remember(session, input, locationPromptForHistory());
        }
        const next = await handleLocationReply(ctx, session, input);
        const spoken = next.awaiting === 'preference'
            ? preferencePromptForHistory()
            : next.awaiting === 'food'
                ? foodPromptForHistory()
                : next.awaiting === 'restaurant'
                    ? suggestionText(next.offeredRestaurants)
                    : hasBookingRestaurant(ctx, next)
                        ? selectedRestaurantText(ctx.restaurant.name, next.data || {})
                        : coveragePromptForHistory(next);
        return remember(next, input, spoken);
    }

    if (!hasBookingRestaurant(ctx, session) && isBookIntent(input)) {
        const extra = leftoverLocation(input);
        if (extra) {
            const next = await handleLocationReply(ctx, session, extra);
            return remember(next, input, next.awaiting === 'preference'
                ? preferencePromptForHistory()
                : next.awaiting === 'restaurant'
                    ? suggestionText(next.offeredRestaurants)
                    : coveragePromptForHistory(next));
        }
        const next = await beginRestaurantPick(ctx, session);
        if (hasBookingRestaurant(ctx, next)) {
            return remember(next, input, selectedRestaurantText(ctx.restaurant.name, next.data || {}));
        }
        return remember(next, input, locationPromptForHistory());
    }

    return null;
}

// ── Tool execution ───────────────────────────────────────────────────────────

function checkDate(date, today) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return 'Date must be YYYY-MM-DD.';
    const problem = dateProblem(date, today);
    if (problem === 'past') return 'That date has already passed.';
    if (problem === 'too_far') return `Bookings are only taken up to ${MAX_ADVANCE_DAYS} days ahead.`;
    return null;
}

function checkTime(time, date, ctx) {
    const hm = parseTimeInput(time);
    if (!hm) return { error: 'Time must be HH:mm (24-hour).' };
    const tz = timezoneOf(ctx.restaurant);
    if (date === todayInTz(tz, ctx.now) && hmToMinutes(hm) < minutesNowInTz(tz, ctx.now) + MIN_LEAD_MINUTES) {
        return { error: 'That time is too soon or has already passed today.' };
    }
    return { hm };
}

function checkGuests(guests) {
    const n = Number(guests);
    if (!Number.isInteger(n) || n < 1) return { error: 'Number of guests must be a whole number of at least 1.' };
    if (n > MAX_GUESTS) return { error: `Groups larger than ${MAX_GUESTS} must contact the restaurant directly.` };
    return { n };
}

async function alternativesFor(ctx, date, hm, guests) {
    const tz = timezoneOf(ctx.restaurant);
    const slots = await ctx.availability.getDaySlots(ctx.restaurant, date, {
        today: todayInTz(tz, ctx.now),
        minutesNow: minutesNowInTz(tz, ctx.now),
    });
    if (slots.closed) return [];
    return ctx.booking.findAlternatives(ctx.restaurant.id, date, hm, guests, slots.times, ctx.restaurant);
}

function unavailablePayload(check, alternatives) {
    return {
        available: false,
        reason: check.reason === 'closed' ? `closed${check.message ? `: ${check.message}` : ''}` : 'fully booked',
        seats_left: check.seatsLeft ?? null,
        alternatives: alternatives.map((hm) => ({ time: hm, label: formatTime12(hm) })),
    };
}

/**
 * @returns {Promise<{result: Object, booked?: Object}>}
 */
export async function runTool(name, args, ctx, session) {
    if (name === 'find_restaurants') {
        if (!ctx.directory) return { result: { error: 'Restaurant search is not available.' } };
        const location = String(args.location || '').trim();
        if (!location) return { result: { error: 'Please ask which area they want to dine in.' } };
        const next = await handleLocationReply(ctx, session, location);
        if (!next.locationMatches?.length) {
            return {
                result: {
                    matches: [],
                    unmatched: true,
                    areas: uniqueAreaLines(next.coveragePrompt),
                    note: 'The guest was shown real areas we cover. Ask them to pick one. Do not invent a location or restaurant.',
                },
                sessionPatch: next,
            };
        }
        if (next.awaiting === 'restaurant') {
            return {
                result: {
                    area: next.locationQuery,
                    restaurants: (next.offeredRestaurants || []).map((entry) => ({
                        id: entry.id,
                        name: entry.name,
                        address: entry.address || entry.area || '',
                        cuisine: entry.cuisine || entry.description || '',
                    })),
                    note: 'A numbered list of these restaurants was sent. Do not add names. Wait for the guest to pick one.',
                },
                sessionPatch: next,
            };
        }
        return {
            result: {
                area: next.locationQuery,
                candidates: next.locationMatches.length,
                note: 'The system asked a follow-up in ordinary text. Do not list restaurants until that reply is in. Do not invent names.',
            },
            sessionPatch: next,
        };
    }

    if (name === 'select_restaurant') {
        if (!ctx.directory) return { result: { error: 'Restaurant selection is not available.' } };
        const next = await handleRestaurantReply(ctx, session, { type: 'reply', id: `rest:${args.restaurant_id}` });
        if (!hasBookingRestaurant(ctx, next)) {
            return { result: { error: 'That restaurant is not in the list just shown. Ask them to pick by name or number.' }, sessionPatch: next };
        }
        return { result: { selected: true, restaurant_id: next.restaurantId, name: ctx.restaurant.name }, sessionPatch: next };
    }

    if (ctx.directory && !hasBookingRestaurant(ctx, session) && isHostRestaurantId(ctx.restaurant?.id)) {
        return { result: { error: 'A restaurant must be selected first. Ask for their area, call find_restaurants, then select_restaurant.' } };
    }

    const tz = timezoneOf(ctx.restaurant);
    const today = todayInTz(tz, ctx.now);

    if (name === 'get_available_times') {
        const dateError = checkDate(args.date, today);
        if (dateError) return { result: { error: dateError } };
        const slots = await ctx.availability.getDaySlots(ctx.restaurant, args.date, {
            today,
            minutesNow: minutesNowInTz(tz, ctx.now),
        });
        if (slots.closed) return { result: { date: args.date, closed: true, reason: slots.reason || null } };
        return {
            result: {
                date: args.date,
                day: formatDateLong(args.date),
                times: slots.times.map((hm) => ({ time: hm, label: formatTime12(hm) })),
                note: 'Opening-hour slots. Confirm seats with check_availability.',
            },
        };
    }

    if (name === 'check_availability') {
        const dateError = checkDate(args.date, today);
        if (dateError) return { result: { error: dateError } };
        const time = checkTime(args.time, args.date, ctx);
        if (time.error) return { result: { error: time.error } };
        const guests = checkGuests(args.guests);
        if (guests.error) return { result: { error: guests.error } };

        const check = await ctx.booking.checkSlot(ctx.restaurant.id, args.date, time.hm, guests.n, ctx.restaurant);
        if (check.ok) {
            return { result: { available: true, date: args.date, day: formatDateLong(args.date), time: time.hm, label: formatTime12(time.hm), guests: guests.n } };
        }
        const alternatives = await alternativesFor(ctx, args.date, time.hm, guests.n);
        return { result: unavailablePayload(check, alternatives) };
    }

    if (name === 'create_booking') {
        const nameOk = validateName(args.name);
        if (!nameOk) return { result: { error: 'Please get the guest\'s name (letters only).' } };
        const dateError = checkDate(args.date, today);
        if (dateError) return { result: { error: dateError } };
        const time = checkTime(args.time, args.date, ctx);
        if (time.error) return { result: { error: time.error } };
        const guests = checkGuests(args.guests);
        if (guests.error) return { result: { error: guests.error } };

        let phone = `+${ctx.waId}`;
        if (args.phone && String(args.phone).trim()) {
            phone = normalisePhoneInput(args.phone, ctx.waId);
            if (!phone) return { result: { error: 'That contact number is not valid. Ask for the full number.' } };
        }
        const requests = args.special_requests ? (validateRequests(args.special_requests) || '') : '';

        const last = session.lastBooking;
        if (last && last.date === args.date && last.time === time.hm && Number(last.guests) === guests.n) {
            return { result: { status: 'already_booked', note: 'This booking was already made in this chat. Do not book again.' } };
        }

        const data = { name: nameOk, phone, guests: guests.n, date: args.date, time: time.hm, requests, sittingId: null };
        const outcome = await ctx.booking.book({ restaurant: ctx.restaurant, waId: ctx.waId, data });

        if (outcome.status === 'booked') return { result: { status: 'booked' }, booked: { data, outcome } };
        if (outcome.status === 'unavailable') {
            const alternatives = await alternativesFor(ctx, args.date, time.hm, guests.n);
            return { result: { status: 'not_booked', ...unavailablePayload(outcome.check, alternatives) } };
        }
        return { result: { status: 'error', error: 'The booking system did not respond. Apologise and suggest trying again shortly or contacting the restaurant.' } };
    }

    return { result: { error: `Unknown tool ${name}` } };
}

// ── Conversation ─────────────────────────────────────────────────────────────

async function finishBooking(ctx, session, booked) {
    const { data, outcome } = booked;
    await ctx.client.sendText(ctx.waId, confirmationText(ctx.restaurant, data, outcome));
    try {
        await ctx.contacts.saveBooking({
            waId: ctx.waId,
            profileName: ctx.profileName || null,
            restaurantId: ctx.restaurant.id,
            data,
            paymentId: outcome.paymentId,
        });
    } catch (error) {
        logger.error(`❌ [WhatsApp AI] Saving contact for ${ctx.waId} failed: ${error.message}`);
    }
    return {
        paymentId: outcome.paymentId,
        date: data.date,
        time: data.time,
        guests: data.guests,
    };
}

/**
 * Reasoning models (gpt-5 and later, o-series) reject `temperature`, and in
 * Chat Completions only allow function tools with reasoning_effort 'none'.
 */
export function modelSettings(model) {
    if (/^(gpt-([5-9]|\d{2,})|o\d)/i.test(String(model))) return { reasoning_effort: 'none' };
    return { temperature: 0.6 };
}

function fallbackText(ctx) {
    const contact = ctx.config.contactInfo ? ` or reach us on ${ctx.config.contactInfo}` : '';
    return `Sorry, I'm having a little trouble on my side right now. Please try again in a minute${contact}.`;
}

/**
 * @returns {Promise<Object|null>} next session, or null to clear it
 */
export async function handleAiMessage(input, existingSession, ctx) {
    let session = isFresh(existingSession, ctx) ? existingSession : newAiSession(ctx);
    const lower = input.type === 'text'
        ? String(input.text || '').trim().toLowerCase().replace(/[!.,?\s]+$/, '')
        : '';
    const today = todayInTz(timezoneOf(ctx.restaurant), ctx.now || new Date());

    if (CANCEL_WORDS.has(lower) && session.history.length > 0 && !session.lastBooking) {
        await ctx.client.sendText(ctx.waId, cancelledText());
        return null;
    }
    if (RESET_WORDS.has(lower)) {
        session = newAiSession(ctx);
        if (ctx.directory && typeof ctx.hostRestaurant === 'function') ctx.restaurant = ctx.hostRestaurant();
    }

    if (input.type === 'text') {
        session = applyExtract(session, extractBookingDetails(input.text, { today }));
        if (session.lastCorrection === 'guests' && session.data?.guests && session.history?.length) {
            await ctx.client.sendText(ctx.waId, `Of course, I've updated that to ${session.data.guests} guests.`);
            return remember({ ...session, lastCorrection: null }, input, `Of course, I've updated that to ${session.data.guests} guests.`);
        }
    }

    if (isGreetingOnly(input.type === 'text' ? input.text : '') && session.history?.length > 0) {
        const followUp = session.awaiting === 'location' || ctx.directory
            ? 'Hi again — which area would you like to dine in?'
            : 'Hi again — shall we continue with your booking?';
        await ctx.client.sendText(ctx.waId, followUp);
        return remember(session, input, followUp);
    }

    if (!session.history || session.history.length === 0) {
        const extracted = extractBookingDetails(inputToText(input), { today });
        if (ctx.directory && (hasCollectedBits(extracted) || isBookIntent(input))) {
            if (extracted.location) {
                const next = await handleLocationReply(ctx, session, extracted.location);
                const spoken = next.awaiting === 'preference'
                    ? preferencePromptForHistory()
                    : next.awaiting === 'restaurant'
                        ? suggestionText(next.offeredRestaurants)
                        : coveragePromptForHistory(next);
                return remember(next, input, spoken);
            }
            await ctx.client.sendText(ctx.waId, LOCATION_PROMPT);
            return {
                ...session,
                awaiting: 'location',
                history: [
                    { role: 'user', content: inputToText(input) || '(empty message)' },
                    { role: 'assistant', content: LOCATION_PROMPT },
                ],
            };
        }
        const intro = welcomeText(ctx.restaurant, { host: Boolean(ctx.directory) });
        await sendWelcome(ctx);
        return {
            ...session,
            awaiting: ctx.directory ? 'location' : session.awaiting,
            history: [
                { role: 'user', content: inputToText(input) || '(empty message)' },
                { role: 'assistant', content: intro },
            ],
        };
    }

    if (ctx.directory) {
        const picked = await handleRestaurantSelectionTurn(input, session, ctx);
        if (picked) return picked;
    }

    let knownName = null;
    try {
        knownName = validateName(await ctx.contacts.getKnownName(ctx.waId));
    } catch (error) {
        logger.warn(`⚠️ [WhatsApp AI] Known-name lookup failed for ${ctx.waId}: ${error.message}`);
    }
    knownName = knownName || validateName(ctx.profileName);

    const history = [...(session.history || []), { role: 'user', content: inputToText(input) || '(empty message)' }];
    const system = buildSystemPrompt({ restaurant: ctx.restaurant, config: ctx.config, waId: ctx.waId, knownName, now: ctx.now, session });
    let lastBooking = session.lastBooking || null;

    try {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            const model = ctx.config.aiModel || DEFAULT_AI_MODEL;
            const completion = await ctx.ai.chat.completions.create({
                model,
                ...modelSettings(model),
                messages: [{ role: 'system', content: system }, ...history],
                tools: toolsFor(ctx, session),
                tool_choice: 'auto',
            });
            const message = completion.choices?.[0]?.message;
            if (!message) throw new Error('Empty completion');

            const toolCalls = message.tool_calls || [];
            if (toolCalls.length === 0) {
                const reply = String(message.content || '').trim();
                if (reply) {
                    await ctx.client.sendText(ctx.waId, reply);
                    history.push({ role: 'assistant', content: reply });
                }
                return { ...session, history: trimHistory(history), lastBooking };
            }

            history.push({ role: 'assistant', content: message.content || null, tool_calls: toolCalls });
            let bookedNow = null;
            let pickerDone = false;
            for (const call of toolCalls) {
                let args = {};
                try {
                    args = JSON.parse(call.function?.arguments || '{}');
                } catch {
                    args = {};
                }
                logger.info(`🛠️ [WhatsApp AI] ${ctx.waId} → ${call.function?.name} ${JSON.stringify(args)}`);
                const { result, booked, sessionPatch } = await runTool(call.function?.name, args, ctx, { ...session, lastBooking });
                if (sessionPatch) session = { ...session, ...sessionPatch };
                if (booked) {
                    lastBooking = await finishBooking(ctx, session, booked);
                    bookedNow = booked;
                }
                if (call.function?.name === 'find_restaurants' || call.function?.name === 'select_restaurant') pickerDone = true;
                history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
            }

            if (bookedNow) {
                history.push({ role: 'assistant', content: '(Confirmation and payment details were sent to the guest.)' });
                return { ...session, history: trimHistory(history), lastBooking };
            }
            if (pickerDone) {
                return { ...session, history: trimHistory(history), lastBooking };
            }
        }
        throw new Error('Too many tool rounds');
    } catch (error) {
        logger.error(`❌ [WhatsApp AI] Reply failed for ${ctx.waId}: ${error.message}`);
        await ctx.client.sendText(ctx.waId, fallbackText(ctx));
        return { ...session, lastBooking };
    }
}
