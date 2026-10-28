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
import { toMillis } from './whatsappSessionStore.js';
import {
    cancelledText,
    confirmationText,
    formatMoney,
    MAX_GUESTS,
    sendWelcome,
    WELCOME_ROWS,
    welcomeText,
} from './whatsappSteps.js';

export const DEFAULT_AI_MODEL = 'gpt-4.1-mini';

const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY = 40;
const MAX_TOOL_ROUNDS = 5;
const MIN_LEAD_MINUTES = 30;
const CALENDAR_DAYS = 14;

const RESET_WORDS = new Set(['restart', 'start over', 'reset', 'menu']);
const CANCEL_WORDS = new Set(['cancel', 'cancel booking']);

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

export function buildSystemPrompt({ restaurant, config, waId, knownName, now }) {
    const tz = timezoneOf(restaurant);
    const today = todayInTz(tz, now);
    const nowHm = minutesNowInTz(tz, now);
    const clock = formatTime12(`${String(Math.floor(nowHm / 60)).padStart(2, '0')}:${String(nowHm % 60).padStart(2, '0')}`);
    const deposit = Number(restaurant.depositAmount) || 0;

    return `You are the WhatsApp host for ${restaurant.name}. You chat with guests the way a friendly, experienced member of the front-of-house team would: warm, natural and efficient. You are not a menu bot.

How you write
- Short WhatsApp messages: usually 1–3 sentences. Ask only one question per message.
- Sound human. Vary your wording, acknowledge what they said ("Lovely", "Perfect, noted"), use their first name once you know it.
- No bullet lists, headings or numbered menus. At most one emoji now and then.
- Reply in the guest's language.
- If asked whether you are a person, say you are ${restaurant.name}'s virtual assistant.

What you know
- Today is ${formatDateLong(today)}, about ${clock} (${tz}).
- Calendar for resolving dates like "Tuesday" or "3 Nov":
${calendarLines(today)}
- Bookings are taken up to ${MAX_ADVANCE_DAYS} days ahead, at least ${MIN_LEAD_MINUTES} minutes from now. Groups larger than ${MAX_GUESTS}: ask them to contact the restaurant.
- Deposit: ${deposit > 0 ? `${formatMoney(deposit, restaurant.currency)} per guest, paid through a secure link sent after booking` : 'none required'}.
- Menu: ${config.menuUrl || 'not available on WhatsApp'}.
- Contact details: ${config.contactInfo || 'not provided'}.
- The guest's WhatsApp number is +${waId}.${knownName ? `\n- Their name is probably ${knownName} (from an earlier booking or their WhatsApp profile). When you need the name, offer it, e.g. "Shall I put it under ${knownName.split(' ')[0]}?", instead of asking from scratch.` : ''}

Taking a booking
- You need: name, number of guests, date and time. Use their WhatsApp number as the contact number unless they give another. Ask once, lightly, about allergies or a special occasion.
- Collect details conversationally. If they give several at once, take them all; don't re-ask.
- Once you know the date, you may call get_available_times to suggest times.
- Before saying a time works, call check_availability with date, time and guests. Never guess or invent availability. If it is not available, offer two or three of the returned alternatives.
- When everything is known and available, recap in one short message (name, guests, day and date, time, requests${deposit > 0 ? ', deposit amount' : ''}) and ask them to confirm.
- Only call create_booking after a clear yes. Do not write a confirmation or a payment link yourself; the system sends them.
- If a tool returns an error, explain it simply and ask for what is needed.

Other questions
- Answer from what you know above. If you don't know (prices, parking, specific dishes), say so honestly and share the menu link or contact details. Never make things up.
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
    return { mode: 'ai', restaurantId: ctx.restaurant.id, history: [] };
}

function isFresh(session, ctx) {
    if (!session || session.mode !== 'ai' || session.restaurantId !== ctx.restaurant.id) return false;
    const updated = toMillis(session.updatedAt);
    return !updated || ctx.now.getTime() - updated <= SESSION_IDLE_MS;
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
    return ctx.booking.findAlternatives(ctx.restaurant.id, date, hm, guests, slots.times);
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

        const check = await ctx.booking.checkSlot(ctx.restaurant.id, args.date, time.hm, guests.n);
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

function fallbackText(ctx) {
    const contact = ctx.config.contactInfo ? ` or reach us on ${ctx.config.contactInfo}` : '';
    return `Sorry, I'm having a little trouble on my side right now. Please try again in a minute${contact}.`;
}

/**
 * @returns {Promise<Object|null>} next session, or null to clear it
 */
export async function handleAiMessage(input, existingSession, ctx) {
    let session = isFresh(existingSession, ctx) ? existingSession : newAiSession(ctx);
    const lower = input.type === 'text' ? String(input.text || '').trim().toLowerCase() : '';

    if (CANCEL_WORDS.has(lower) && session.history.length > 0 && !session.lastBooking) {
        await ctx.client.sendText(ctx.waId, cancelledText());
        return null;
    }
    if (RESET_WORDS.has(lower)) session = newAiSession(ctx);

    if (!session.history || session.history.length === 0) {
        await sendWelcome(ctx);
        return {
            ...session,
            history: [
                { role: 'user', content: inputToText(input) || '(empty message)' },
                { role: 'assistant', content: `${welcomeText(ctx.restaurant)}\n[Options shown: ${WELCOME_ROWS.map((r) => r.title).join(', ')}]` },
            ],
        };
    }

    let knownName = null;
    try {
        knownName = validateName(await ctx.contacts.getKnownName(ctx.waId));
    } catch (error) {
        logger.warn(`⚠️ [WhatsApp AI] Known-name lookup failed for ${ctx.waId}: ${error.message}`);
    }
    knownName = knownName || validateName(ctx.profileName);

    const history = [...(session.history || []), { role: 'user', content: inputToText(input) || '(empty message)' }];
    const system = buildSystemPrompt({ restaurant: ctx.restaurant, config: ctx.config, waId: ctx.waId, knownName, now: ctx.now });
    let lastBooking = session.lastBooking || null;

    try {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            const completion = await ctx.ai.chat.completions.create({
                model: ctx.config.aiModel || DEFAULT_AI_MODEL,
                temperature: 0.6,
                messages: [{ role: 'system', content: system }, ...history],
                tools: AI_TOOLS,
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
            for (const call of toolCalls) {
                let args = {};
                try {
                    args = JSON.parse(call.function?.arguments || '{}');
                } catch {
                    args = {};
                }
                logger.info(`🛠️ [WhatsApp AI] ${ctx.waId} → ${call.function?.name} ${JSON.stringify(args)}`);
                const { result, booked } = await runTool(call.function?.name, args, ctx, { ...session, lastBooking });
                if (booked) {
                    lastBooking = await finishBooking(ctx, session, booked);
                    bookedNow = booked;
                }
                history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
            }

            if (bookedNow) {
                history.push({ role: 'assistant', content: '(Confirmation and payment details were sent to the guest.)' });
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
