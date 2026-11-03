// src/services/whatsapp/whatsappHandlers.js
// =============================================================================
// WHATSAPP BOOKING FLOW — state machine
// =============================================================================
// handleMessage(input, session, ctx) → next session (or null to clear it).
//
// input:   { type: 'text', text } | { type: 'reply', id, title } | { type: 'unsupported', kind }
// ctx:     { waId, profileName, restaurant, client, config, now,
//            availability: { getDaySlots },
//            booking: { checkSlot, findAlternatives, book },
//            contacts: { getKnownName, saveBooking } }
//
// Steps: welcome → location → preference → food → restaurant → name → phone → guests (→ guests_more) → date → time
//        → requests → confirm → done
// Global: "menu" / "restart" / "hi" → welcome, "cancel" → clear session.
// =============================================================================

import logger from '../../utils/logger.js';
import { DEFAULT_TIMEZONE } from './whatsappConfig.js';
import {
    dateProblem,
    formatTime12,
    hmToMinutes,
    MAX_ADVANCE_DAYS,
    minutesNowInTz,
    parseDateInput,
    parseTimeInput,
    todayInTz,
} from './whatsappDateTime.js';
import {
    askConfirm,
    askDate,
    askGuests,
    askGuestsMore,
    askName,
    askPhone,
    askRequests,
    askTime,
    cancelledText,
    confirmationText,
    MAX_GUESTS,
    MAX_REQUEST_LENGTH,
    REPLY,
    sendFoodPrompt,
    sendLocationPrompt,
    sendPreferencePrompt,
    sendWelcome,
    STEP,
    unsupportedText,
} from './whatsappSteps.js';
import {
    beginRestaurantPick,
    handleFoodReply,
    handleLocationReply,
    handlePreferenceReply,
    handleRestaurantReply,
    hasBookingRestaurant,
    sendRestaurantSuggestions,
} from './whatsappRestaurantPicker.js';
import { HOST_RESTAURANT_ID } from './whatsappRestaurantDirectory.js';
import { toMillis } from './whatsappSessionStore.js';

const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
const MIN_LEAD_MINUTES = 30;

const GREETINGS = new Set(['hi', 'hello', 'hey', 'hallo', 'hiya', 'howzit', 'good morning', 'good afternoon', 'good evening']);
const MENU_WORDS = new Set(['menu', 'restart', 'start', 'start over', 'main menu']);
const CANCEL_WORDS = new Set(['cancel', 'cancel booking']);

// ── Validation ───────────────────────────────────────────────────────────────

export function validateName(text) {
    const name = String(text || '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 60) return null;
    if (!/^\p{L}[\p{L}\p{M}' .-]*$/u.test(name)) return null;
    if ((name.match(/\p{L}/gu) || []).length < 2) return null;
    return name;
}

function countryCodeFor(waId) {
    if (waId.startsWith('27')) return '27';
    if (waId.startsWith('91')) return '91';
    if (waId.startsWith('1') && waId.length === 11) return '1';
    return null;
}

/** Returns E.164 ("+27821234567") or null. Local numbers use the sender's country. */
export function normalisePhoneInput(text, waId = '') {
    const raw = String(text || '').trim();
    if (!/^[+\d][\d\s().-]*$/.test(raw)) return null;
    const digits = raw.replace(/\D/g, '');

    if (raw.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
    if (digits.startsWith('00')) return digits.length - 2 >= 8 && digits.length - 2 <= 15 ? `+${digits.slice(2)}` : null;

    const cc = countryCodeFor(waId);
    if (digits.startsWith('0') && digits.length === 10) return `+${cc || '27'}${digits.slice(1)}`;
    if (digits.length === 10 && cc && cc !== '27') return `+${cc}${digits}`;
    if (digits.length === 9) return `+${cc || '27'}${digits}`;
    if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
    return null;
}

/** "4", "4 people", "four"-free: digits only. */
export function parseGuests(text) {
    const match = String(text || '').trim().match(/^(\d{1,3})(?:\s*(?:guests?|people|persons?|pax))?$/i);
    return match ? Number(match[1]) : null;
}

export function validateRequests(text) {
    const value = String(text || '').trim().replace(/\s+/g, ' ');
    if (!value || value.length > MAX_REQUEST_LENGTH) return null;
    return value;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function timezoneOf(ctx) {
    return ctx.restaurant.timezone || DEFAULT_TIMEZONE;
}

function today(ctx) {
    return todayInTz(timezoneOf(ctx), ctx.now);
}

function newSession(ctx, step, data = {}) {
    const restaurantId = ctx.directory ? HOST_RESTAURANT_ID : ctx.restaurant.id;
    return { step, restaurantId, data };
}

function isFresh(session, ctx) {
    if (!session) return false;
    if (ctx.directory) {
        if (session.restaurantId !== ctx.restaurant.id && session.restaurantId !== HOST_RESTAURANT_ID) return false;
    } else if (session.restaurantId !== ctx.restaurant.id) {
        return false;
    }
    const updated = toMillis(session.updatedAt);
    return !updated || ctx.now.getTime() - updated <= SESSION_IDLE_MS;
}

function unavailableText(check, hm, guests) {
    if (check.reason === 'closed') {
        return `Sorry, we can't take bookings at ${formatTime12(hm)} on that day${check.message ? ` (${check.message})` : ''}.`;
    }
    const seats = Number(check.seatsLeft);
    const left = seats > 0 ? ` Only ${seats} ${seats === 1 ? 'seat is' : 'seats are'} left.` : '';
    return `Sorry, ${formatTime12(hm)} is fully booked for ${guests} ${Number(guests) === 1 ? 'guest' : 'guests'}.${left}`;
}

async function startBooking(ctx) {
    let suggestedName = null;
    try {
        suggestedName = validateName(await ctx.contacts.getKnownName(ctx.waId));
    } catch (error) {
        logger.warn(`⚠️ [WhatsApp] Known-name lookup failed for ${ctx.waId}: ${error.message}`);
    }
    suggestedName = suggestedName || validateName(ctx.profileName);
    const data = suggestedName ? { suggestedName } : {};

    if (ctx.directory) {
        const picking = await beginRestaurantPick(ctx, newSession(ctx, STEP.LOCATION, data));
        if (hasBookingRestaurant(ctx, picking)) {
            const session = { ...picking, step: STEP.NAME, data: { ...data, ...(picking.data || {}) } };
            await askName(ctx, session);
            return session;
        }
        return { ...picking, data: { ...data, ...(picking.data || {}) } };
    }

    const session = newSession(ctx, STEP.NAME, data);
    await askName(ctx, session);
    return session;
}

async function handleLocation(input, session, ctx) {
    const next = await handleLocationReply(ctx, session, input);
    if (hasBookingRestaurant(ctx, next) && next.step === STEP.NAME) {
        await askName(ctx, next);
    }
    return next;
}

async function handlePreference(input, session, ctx) {
    return handlePreferenceReply(ctx, session, input);
}

async function handleFood(input, session, ctx) {
    return handleFoodReply(ctx, session, input);
}

async function handleRestaurantStep(input, session, ctx) {
    const next = await handleRestaurantReply(ctx, session, input);
    if (hasBookingRestaurant(ctx, next) && next.step === STEP.NAME) {
        await askName(ctx, next);
    }
    return next;
}

async function goToDate(ctx, session, prefix) {
    await askDate(ctx, today(ctx), prefix);
    return { ...session, step: STEP.DATE };
}

/** Offers nearby open times, or sends the guest back to choose a date. */
async function offerAlternatives(ctx, session, check, hm) {
    const { date, guests, offeredTimes = [] } = session.data;
    const message = unavailableText(check, hm, guests);
    const alternatives = await ctx.booking.findAlternatives(ctx.restaurant.id, date, hm, guests, offeredTimes);

    if (alternatives.length > 0) {
        await askTime(ctx, date, alternatives, `${message}\n\nThese times are available:`);
        return { ...session, step: STEP.TIME, data: { ...session.data, time: null, sittingId: null, offeredTimes: alternatives } };
    }
    return goToDate(ctx, { ...session, data: { ...session.data, time: null, sittingId: null } },
        `${message} There are no other times available that day. Please choose another date.`);
}

/** Re-sends the prompt for the current step. */
export async function reprompt(ctx, session, prefix) {
    const data = session.data || {};
    switch (session.step) {
        case STEP.LOCATION:
            if (session.offeredRestaurants?.length) await sendRestaurantSuggestions(ctx, session.offeredRestaurants);
            else await sendLocationPrompt(ctx);
            break;
        case STEP.PREFERENCE: await sendPreferencePrompt(ctx); break;
        case STEP.FOOD: await sendFoodPrompt(ctx); break;
        case STEP.RESTAURANT:
            if (session.offeredRestaurants?.length) await sendRestaurantSuggestions(ctx, session.offeredRestaurants);
            else await sendLocationPrompt(ctx);
            break;
        case STEP.NAME: await askName(ctx, session, prefix); break;
        case STEP.PHONE: await askPhone(ctx, prefix); break;
        case STEP.GUESTS: await askGuests(ctx, prefix); break;
        case STEP.GUESTS_MORE: await askGuestsMore(ctx, prefix); break;
        case STEP.DATE: await askDate(ctx, today(ctx), prefix); break;
        case STEP.TIME: await askTime(ctx, data.date, data.offeredTimes || [], prefix); break;
        case STEP.REQUESTS: await askRequests(ctx, prefix); break;
        case STEP.CONFIRM: await askConfirm(ctx, data, prefix); break;
        default:
            await sendWelcome(ctx, prefix ? `${prefix}\n\nHow can I help you today?` : undefined);
            return newSession(ctx, STEP.WELCOME);
    }
    return session;
}

// ── Step handlers ────────────────────────────────────────────────────────────

async function handleMenuChoice(id, ctx) {
    if (id === REPLY.BOOK) return startBooking(ctx);

    if (id === REPLY.VIEW_MENU) {
        const { menuUrl } = ctx.config;
        await ctx.client.sendText(ctx.waId, menuUrl
            ? `Here's our menu: ${menuUrl}`
            : "Sorry, our menu isn't available on WhatsApp yet.");
    } else {
        const { contactInfo } = ctx.config;
        await ctx.client.sendText(ctx.waId, contactInfo
            ? `You can reach ${ctx.restaurant.name} here:\n${contactInfo}`
            : `Please contact ${ctx.restaurant.name} directly.`);
    }
    await sendWelcome(ctx, 'Anything else I can help with?');
    return newSession(ctx, STEP.WELCOME);
}

async function handleName(input, session, ctx) {
    let name = null;
    if (input.type === 'reply' && input.id === REPLY.NAME_SUGGESTED) name = session.data.suggestedName || null;
    if (input.type === 'text') name = validateName(input.text);

    if (!name) {
        await askName(ctx, session, 'Please send the name for the booking, using letters only (e.g. Thandi Mokoena).');
        return session;
    }
    await askPhone(ctx);
    return { ...session, step: STEP.PHONE, data: { ...session.data, name } };
}

async function handlePhone(input, session, ctx) {
    let phone = null;
    if (input.type === 'reply' && input.id === REPLY.PHONE_WHATSAPP) phone = `+${ctx.waId}`;
    if (input.type === 'text') phone = normalisePhoneInput(input.text, ctx.waId);

    if (!phone) {
        await askPhone(ctx, "That doesn't look like a valid phone number. Please include the full number, e.g. 082 123 4567 or +27 82 123 4567.");
        return session;
    }
    await askGuests(ctx);
    return { ...session, step: STEP.GUESTS, data: { ...session.data, phone } };
}

async function acceptGuests(guests, session, ctx, retryStep) {
    if (guests > MAX_GUESTS) {
        const contact = ctx.config.contactInfo ? `: ${ctx.config.contactInfo}` : ' directly';
        await ctx.client.sendText(ctx.waId, `For groups larger than ${MAX_GUESTS}, please contact us${contact}.`);
        await reprompt(ctx, { ...session, step: retryStep });
        return { ...session, step: retryStep };
    }
    return goToDate(ctx, { ...session, data: { ...session.data, guests } });
}

async function handleGuests(input, session, ctx) {
    if (input.type === 'reply' && input.id === REPLY.GUESTS_MORE) {
        await askGuestsMore(ctx);
        return { ...session, step: STEP.GUESTS_MORE };
    }

    let guests = null;
    if (input.type === 'reply' && /^guests:\d+$/.test(input.id)) guests = Number(input.id.split(':')[1]);
    if (input.type === 'text') guests = parseGuests(input.text);

    if (!guests || guests < 1) {
        await askGuests(ctx, 'Please choose the number of guests from the list, or type a number.');
        return session;
    }
    return acceptGuests(guests, session, ctx, STEP.GUESTS);
}

async function handleGuestsMore(input, session, ctx) {
    const guests = input.type === 'text' ? parseGuests(input.text) : null;
    if (!guests || guests < 1) {
        await askGuestsMore(ctx, "Sorry, I didn't get that.");
        return session;
    }
    return acceptGuests(guests, session, ctx, STEP.GUESTS_MORE);
}

async function handleDate(input, session, ctx) {
    const todayStr = today(ctx);
    let date = null;
    if (input.type === 'reply' && /^date:\d{4}-\d{2}-\d{2}$/.test(input.id)) date = input.id.slice(5);
    if (input.type === 'text') date = parseDateInput(input.text, todayStr);

    if (!date) {
        await askDate(ctx, todayStr, "Sorry, I couldn't read that date.");
        return session;
    }
    const problem = dateProblem(date, todayStr);
    if (problem) {
        await askDate(ctx, todayStr, problem === 'past'
            ? 'That date has already passed.'
            : `We take bookings up to ${MAX_ADVANCE_DAYS} days ahead.`);
        return session;
    }

    const slots = await ctx.availability.getDaySlots(ctx.restaurant, date, {
        today: todayStr,
        minutesNow: minutesNowInTz(timezoneOf(ctx), ctx.now),
    });
    if (slots.closed) {
        await askDate(ctx, todayStr, `Sorry, we're closed on that day${slots.reason ? ` (${slots.reason})` : ''}. Please choose another date.`);
        return session;
    }
    if (slots.times.length === 0) {
        await askDate(ctx, todayStr, 'There are no booking times left on that day. Please choose another date.');
        return session;
    }

    await askTime(ctx, date, slots.times);
    return { ...session, step: STEP.TIME, data: { ...session.data, date, offeredTimes: slots.times } };
}

async function handleTime(input, session, ctx) {
    const { date, guests, offeredTimes = [] } = session.data;
    if (input.type === 'reply' && input.id === REPLY.OTHER_DATE) return goToDate(ctx, session);

    let hm = null;
    if (input.type === 'reply' && /^time:\d{2}:\d{2}$/.test(input.id)) hm = input.id.slice(5);
    if (input.type === 'text') hm = parseTimeInput(input.text);

    if (!hm) {
        await askTime(ctx, date, offeredTimes, "Sorry, I couldn't read that time.");
        return session;
    }
    if (date === today(ctx) && hmToMinutes(hm) < minutesNowInTz(timezoneOf(ctx), ctx.now) + MIN_LEAD_MINUTES) {
        await askTime(ctx, date, offeredTimes, 'That time is too soon or has already passed today.');
        return session;
    }

    const check = await ctx.booking.checkSlot(ctx.restaurant.id, date, hm, guests);
    if (!check.ok) return offerAlternatives(ctx, session, check, hm);

    await askRequests(ctx);
    return { ...session, step: STEP.REQUESTS, data: { ...session.data, time: hm, sittingId: check.sittingId ?? null } };
}

async function handleRequests(input, session, ctx) {
    let requests = null;
    if (input.type === 'reply' && input.id === REPLY.NO_REQUESTS) requests = '';
    if (input.type === 'text') requests = validateRequests(input.text);

    if (requests === null) {
        await askRequests(ctx, `Please type your requests in one message (up to ${MAX_REQUEST_LENGTH} characters), or tap No requests.`);
        return session;
    }
    const data = { ...session.data, requests };
    await askConfirm(ctx, data);
    return { ...session, step: STEP.CONFIRM, data };
}

async function handleConfirm(input, session, ctx) {
    const id = input.type === 'reply' ? input.id : null;

    if (id === REPLY.START_OVER) {
        const next = newSession(ctx, STEP.NAME, session.data.name ? { suggestedName: session.data.name } : {});
        await askName(ctx, next);
        return next;
    }
    if (id === REPLY.CANCEL) {
        await ctx.client.sendText(ctx.waId, cancelledText());
        return null;
    }
    if (id !== REPLY.CONFIRM) {
        await askConfirm(ctx, session.data, 'Please tap Confirm, Start over or Cancel.');
        return session;
    }

    const result = await ctx.booking.book({ restaurant: ctx.restaurant, waId: ctx.waId, data: session.data });

    if (result.status === 'unavailable') {
        return offerAlternatives(ctx, session, result.check, session.data.time);
    }
    if (result.status !== 'booked') {
        const contact = ctx.config.contactInfo ? ` or contact us: ${ctx.config.contactInfo}` : '';
        await askConfirm(ctx, session.data, `Sorry, we couldn't save your booking just now. Please tap Confirm to try again${contact}.`);
        return session;
    }

    await ctx.client.sendText(ctx.waId, confirmationText(ctx.restaurant, session.data, result));

    try {
        await ctx.contacts.saveBooking({
            waId: ctx.waId,
            profileName: ctx.profileName || null,
            restaurantId: ctx.restaurant.id,
            data: session.data,
            paymentId: result.paymentId,
        });
    } catch (error) {
        logger.error(`❌ [WhatsApp] Saving contact for ${ctx.waId} failed: ${error.message}`);
    }

    return {
        ...newSession(ctx, STEP.DONE),
        lastBooking: {
            paymentId: result.paymentId,
            date: session.data.date,
            time: session.data.time,
            guests: session.data.guests,
        },
    };
}

const STEP_HANDLERS = {
    [STEP.LOCATION]: handleLocation,
    [STEP.PREFERENCE]: handlePreference,
    [STEP.FOOD]: handleFood,
    [STEP.RESTAURANT]: handleRestaurantStep,
    [STEP.NAME]: handleName,
    [STEP.PHONE]: handlePhone,
    [STEP.GUESTS]: handleGuests,
    [STEP.GUESTS_MORE]: handleGuestsMore,
    [STEP.DATE]: handleDate,
    [STEP.TIME]: handleTime,
    [STEP.REQUESTS]: handleRequests,
    [STEP.CONFIRM]: handleConfirm,
};

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * @returns {Promise<Object|null>} next session, or null to clear it
 */
export async function handleMessage(input, existingSession, ctx) {
    const session = isFresh(existingSession, ctx) ? existingSession : newSession(ctx, STEP.WELCOME);
    const lower = input.type === 'text' ? String(input.text || '').trim().toLowerCase() : '';

    if (input.type === 'unsupported') {
        if (STEP_HANDLERS[session.step]) return reprompt(ctx, session, unsupportedText());
        await sendWelcome(ctx, `${unsupportedText()}\n\nHow can I help you today?`);
        return newSession(ctx, STEP.WELCOME);
    }

    if (CANCEL_WORDS.has(lower)) {
        await ctx.client.sendText(ctx.waId, cancelledText());
        return null;
    }

    if (MENU_WORDS.has(lower) || GREETINGS.has(lower)) {
        if (ctx.directory && typeof ctx.hostRestaurant === 'function') ctx.restaurant = ctx.hostRestaurant();
        await sendWelcome(ctx);
        return newSession(ctx, STEP.WELCOME);
    }

    if (input.type === 'reply' && String(input.id).startsWith('menu:')) {
        return handleMenuChoice(input.id, ctx);
    }

    const handler = STEP_HANDLERS[session.step];
    if (!handler) {
        await sendWelcome(ctx, session.step === STEP.DONE ? 'Anything else I can help with?' : undefined);
        return newSession(ctx, STEP.WELCOME);
    }
    return handler(input, session, ctx);
}
