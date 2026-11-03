// src/services/whatsapp/whatsappSteps.js
// Prompts for each step of the WhatsApp booking flow. Each function only
// sends messages through ctx.client; state changes live in whatsappHandlers.js.

import {
    formatDateLong,
    formatDateShort,
    formatTime12,
    upcomingDateRows,
} from './whatsappDateTime.js';

export const STEP = {
    WELCOME: 'welcome',
    LOCATION: 'location',
    PREFERENCE: 'preference',
    FOOD: 'food',
    RESTAURANT: 'restaurant',
    NAME: 'name',
    PHONE: 'phone',
    GUESTS: 'guests',
    GUESTS_MORE: 'guests_more',
    DATE: 'date',
    TIME: 'time',
    REQUESTS: 'requests',
    CONFIRM: 'confirm',
    DONE: 'done',
};

export const MAX_GUESTS = 30;
export const MAX_REQUEST_LENGTH = 300;

export const REPLY = {
    BOOK: 'menu:book',
    VIEW_MENU: 'menu:view',
    CONTACT: 'menu:contact',
    PREF_CASUAL: 'pref:casual',
    PREF_DATE: 'pref:date',
    PREF_FAMILY: 'pref:family',
    PREF_BUSINESS: 'pref:business',
    PREF_CELEBRATION: 'pref:celebration',
    PREF_ANY: 'pref:any',
    FOOD_STEAK: 'food:steak',
    FOOD_SEAFOOD: 'food:seafood',
    FOOD_VEGETARIAN: 'food:vegetarian',
    FOOD_WINE: 'food:wine',
    FOOD_ANY: 'food:any',
    NAME_SUGGESTED: 'name:suggested',
    PHONE_WHATSAPP: 'phone:wa',
    GUESTS_MORE: 'guests:more',
    OTHER_DATE: 'time:other-date',
    NO_REQUESTS: 'req:none',
    CONFIRM: 'confirm:yes',
    START_OVER: 'confirm:restart',
    CANCEL: 'confirm:cancel',
};

function withPrefix(prefix, body) {
    return prefix ? `${prefix}\n\n${body}` : body;
}

export function currencySymbol(currency) {
    const code = String(currency || 'ZAR').toUpperCase();
    if (code === 'ZAR') return 'R';
    if (code === 'INR') return '₹';
    if (code === 'USD') return '$';
    if (code === 'GBP') return '£';
    if (code === 'EUR') return '€';
    return `${code} `;
}

export function formatMoney(amount, currency) {
    return `${currencySymbol(currency)}${Number(amount || 0).toFixed(2)}`;
}

export const WELCOME_ROWS = [
    { id: REPLY.BOOK, title: '🍽️ Book a Table', description: 'Date, time and party size' },
    { id: REPLY.VIEW_MENU, title: '📖 View Menu', description: 'See our dishes and drinks' },
    { id: REPLY.CONTACT, title: '📞 Contact Us', description: 'Call or message the restaurant' },
];

/** Welcome as a list: "Choose an option" opens a sheet with one row per action. */
export function welcomeText(restaurant) {
    return `Hello! Welcome to ${restaurant.name} 👋\n\nI'd be happy to help you book a table. What would you like to do?`;
}

export function sendWelcome(ctx, intro) {
    const body = intro || welcomeText(ctx.restaurant);
    return ctx.client.sendList(ctx.waId, body, 'Choose an option', WELCOME_ROWS, 'What can I help with?');
}

export const LOCATION_PROMPT = "Sure! Could you please tell me which area or location you're looking to dine in?";

export function sendLocationPrompt(ctx) {
    return ctx.client.sendText(ctx.waId, LOCATION_PROMPT);
}

export const CHOOSE_OPTION = 'Choose an option';

export const PREFERENCE_PROMPT = 'What kind of evening are you after? Pick one below, or type your own.';
export const PREFERENCE_ROWS = [
    { id: REPLY.PREF_CASUAL, title: 'Casual meal', description: 'Relaxed, no fuss' },
    { id: REPLY.PREF_DATE, title: 'Date night', description: 'Quiet or romantic' },
    { id: REPLY.PREF_FAMILY, title: 'Family gathering', description: 'Kids or a group' },
    { id: REPLY.PREF_BUSINESS, title: 'Business / work', description: 'Lunch or a meeting' },
    { id: REPLY.PREF_CELEBRATION, title: 'Celebration', description: 'Birthday or occasion' },
    { id: REPLY.PREF_ANY, title: 'No preference', description: 'Surprise me' },
];

export function sendPreferencePrompt(ctx) {
    return ctx.client.sendList(ctx.waId, PREFERENCE_PROMPT, CHOOSE_OPTION, PREFERENCE_ROWS, 'Preference');
}

export const FOOD_PROMPT = 'What are you in the mood to eat? Pick one below, or type a dish or cuisine.';
export const FOOD_ROWS = [
    { id: REPLY.FOOD_STEAK, title: 'Steak', description: 'Grills and steakhouse' },
    { id: REPLY.FOOD_SEAFOOD, title: 'Seafood', description: 'Fish and shellfish' },
    { id: REPLY.FOOD_VEGETARIAN, title: 'Vegetarian', description: 'Plant-based dishes' },
    { id: REPLY.FOOD_WINE, title: 'Wine & small plates', description: 'Wine bar, sharing' },
    { id: REPLY.FOOD_ANY, title: 'No preference', description: 'Open to anything' },
];

export function sendFoodPrompt(ctx) {
    return ctx.client.sendList(ctx.waId, FOOD_PROMPT, CHOOSE_OPTION, FOOD_ROWS, 'Food');
}

export function noMatchText() {
    return "I couldn't find a restaurant in that area. Could you try a nearby neighbourhood or city?";
}

export function chooseFromListText() {
    return 'Please choose one of the restaurants I listed, by name or number.';
}

export function noneAvailableText() {
    return "Sorry, we don't have any restaurants available to book right now. Please try again shortly.";
}

export function selectedRestaurantText(name) {
    return `Great — I'll book you at ${name}. What name should the booking be under, and for how many guests?`;
}

export function askName(ctx, session, prefix) {
    const suggested = session.data?.suggestedName;
    if (suggested) {
        return ctx.client.sendButtons(
            ctx.waId,
            withPrefix(prefix, 'What name should the booking be under? Tap below, or type a different name.'),
            [{ id: REPLY.NAME_SUGGESTED, title: `Use ${suggested}` }]
        );
    }
    return ctx.client.sendText(ctx.waId, withPrefix(prefix, 'What name should the booking be under?'));
}

export function askPhone(ctx, prefix) {
    return ctx.client.sendButtons(
        ctx.waId,
        withPrefix(prefix, `What's the best contact number for this booking?\n\nTap below to use +${ctx.waId}, or type another number.`),
        [{ id: REPLY.PHONE_WHATSAPP, title: 'Use this number' }]
    );
}

export function askGuests(ctx, prefix) {
    const rows = Array.from({ length: 9 }, (_, i) => ({
        id: `guests:${i + 1}`,
        title: i === 0 ? '1 guest' : `${i + 1} guests`,
    }));
    rows.push({ id: REPLY.GUESTS_MORE, title: '10 or more' });
    return ctx.client.sendList(
        ctx.waId,
        withPrefix(prefix, 'How many guests, including you?'),
        'Choose guests',
        rows,
        'Party size'
    );
}

export function askGuestsMore(ctx, prefix) {
    return ctx.client.sendText(ctx.waId, withPrefix(prefix, `Please type the number of guests (10 to ${MAX_GUESTS}).`));
}

export function askDate(ctx, today, prefix) {
    return ctx.client.sendList(
        ctx.waId,
        withPrefix(prefix, 'Which date would you like? Pick one below, or type a date like 25/12.'),
        'Choose date',
        upcomingDateRows(today, 10),
        'Dates'
    );
}

/** Up to 9 times plus a "Choose another date" row (10 rows max). */
export function askTime(ctx, date, times, prefix) {
    const rows = times.slice(0, 9).map((hm) => ({ id: `time:${hm}`, title: formatTime12(hm) }));
    rows.push({ id: REPLY.OTHER_DATE, title: 'Choose another date' });
    return ctx.client.sendList(
        ctx.waId,
        withPrefix(prefix, `What time on ${formatDateShort(date)}? Pick one below, or type a time like 19:30.`),
        'Choose time',
        rows,
        'Times'
    );
}

export function askRequests(ctx, prefix) {
    return ctx.client.sendButtons(
        ctx.waId,
        withPrefix(prefix, 'Any special requests or allergies? Type them below, or tap No requests.'),
        [{ id: REPLY.NO_REQUESTS, title: 'No requests' }]
    );
}

export function summaryText(restaurant, data) {
    const lines = [
        `Please check your booking at ${restaurant.name}:`,
        '',
        `👤 Name: ${data.name}`,
        `📞 Phone: ${data.phone}`,
        `👥 Guests: ${data.guests}`,
        `📅 Date: ${formatDateLong(data.date)}`,
        `🕒 Time: ${formatTime12(data.time)}`,
        `📝 Requests: ${data.requests || 'None'}`,
    ];
    const deposit = Number(restaurant.depositAmount) || 0;
    if (deposit > 0) {
        lines.push(`💳 Deposit: ${formatMoney(deposit * Number(data.guests), restaurant.currency)} (${formatMoney(deposit, restaurant.currency)} per guest)`);
    }
    return lines.join('\n');
}

export function askConfirm(ctx, data, prefix) {
    return ctx.client.sendButtons(
        ctx.waId,
        withPrefix(prefix, summaryText(ctx.restaurant, data)),
        [
            { id: REPLY.CONFIRM, title: 'Confirm' },
            { id: REPLY.START_OVER, title: 'Start over' },
            { id: REPLY.CANCEL, title: 'Cancel' },
        ]
    );
}

export function confirmationText(restaurant, data, result) {
    const lines = [
        '✅ Your booking is confirmed!',
        '',
        `🍽️ ${restaurant.name}`,
        `👤 ${data.name}`,
        `📅 ${formatDateLong(data.date)}`,
        `🕒 ${formatTime12(data.time)}`,
        `👥 ${data.guests} ${Number(data.guests) === 1 ? 'guest' : 'guests'}`,
    ];
    if (data.requests) lines.push(`📝 ${data.requests}`);
    lines.push(`🔖 Reference: ${String(result.paymentId).slice(0, 8).toUpperCase()}`);

    if (result.paymentLink) {
        lines.push(
            '',
            `💳 To secure your table, please pay the deposit of ${formatMoney(result.bookingAmount, restaurant.currency)} here:`,
            result.paymentLink
        );
    } else {
        lines.push('', 'We look forward to seeing you!');
    }
    lines.push('', 'Send "menu" any time to start again.');
    return lines.join('\n');
}

export function cancelledText() {
    return 'Your booking request has been cancelled. Send "hi" whenever you\'d like to start again.';
}

export function unsupportedText() {
    return 'Sorry, I can only read text messages and button taps for now. Please type your answer or use the options.';
}
