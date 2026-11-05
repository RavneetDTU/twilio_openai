// src/services/whatsapp/whatsappSteps.js
// Prompts for each step of the WhatsApp booking flow. Each function only
// sends messages through ctx.client; state changes live in whatsappHandlers.js.

import {
    formatDateLong,
    formatDateShort,
    formatTime12,
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

export function welcomeText(restaurant, { host = false } = {}) {
    if (host) {
        return 'Hello — I can help you find a restaurant and book a table. Which area are you hoping to dine in?';
    }
    return `Hello — welcome to ${restaurant.name}. I can help you book a table. Tell me when you'd like to visit, or ask a question.`;
}

export function sendWelcome(ctx, intro) {
    const body = intro || welcomeText(ctx.restaurant, { host: Boolean(ctx.directory) });
    return ctx.client.sendText(ctx.waId, body);
}

export const LOCATION_PROMPT = 'Of course. Which area or neighbourhood would you like to dine in?';

export function sendLocationPrompt(ctx) {
    return ctx.client.sendText(ctx.waId, LOCATION_PROMPT);
}

export const CHOOSE_OPTION = 'Choose an option';

export const PREFERENCE_PROMPT = 'Of course! What sort of place are you in the mood for? Somewhere romantic, relaxed, lively, or perhaps something else?';
export const PREFERENCE_ROWS = [
    { id: REPLY.PREF_CASUAL, title: 'Casual meal', description: 'Relaxed, no fuss' },
    { id: REPLY.PREF_DATE, title: 'Date night', description: 'Quiet or romantic' },
    { id: REPLY.PREF_FAMILY, title: 'Family gathering', description: 'Kids or a group' },
    { id: REPLY.PREF_BUSINESS, title: 'Business / work', description: 'Lunch or a meeting' },
    { id: REPLY.PREF_CELEBRATION, title: 'Celebration', description: 'Birthday or occasion' },
    { id: REPLY.PREF_ANY, title: 'No preference', description: 'Surprise me' },
];

export function sendPreferencePrompt(ctx) {
    return ctx.client.sendText(ctx.waId, PREFERENCE_PROMPT);
}

export const FOOD_PROMPT = 'Do you have a particular cuisine in mind, or would you like me to suggest a few options?';
export const FOOD_ROWS = [
    { id: REPLY.FOOD_STEAK, title: 'Steak', description: 'Grills and steakhouse' },
    { id: REPLY.FOOD_SEAFOOD, title: 'Seafood', description: 'Fish and shellfish' },
    { id: REPLY.FOOD_VEGETARIAN, title: 'Vegetarian', description: 'Plant-based dishes' },
    { id: REPLY.FOOD_WINE, title: 'Wine & small plates', description: 'Wine bar, sharing' },
    { id: REPLY.FOOD_ANY, title: 'No preference', description: 'Open to anything' },
];

export function sendFoodPrompt(ctx) {
    return ctx.client.sendText(ctx.waId, FOOD_PROMPT);
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

export function selectedRestaurantText(name, data = {}) {
    const missing = [];
    if (!data.name) missing.push('the name for the booking');
    if (!data.guests) missing.push('how many people will be joining you');
    if (!data.date) missing.push('the date');
    if (!data.time) missing.push('the time');
    if (!missing.length) {
        return `Lovely — I'll book you at ${name}. Let me just recap the details before we confirm.`;
    }
    if (missing.length === 1) return `Lovely — I'll book you at ${name}. ${missing[0][0].toUpperCase()}${missing[0].slice(1)}?`;
    return `Lovely — I'll book you at ${name}. ${missing[0][0].toUpperCase()}${missing[0].slice(1)}?`;
}

export function askName(ctx, session, prefix) {
    const suggested = session.data?.suggestedName;
    const question = suggested
        ? `What name should the booking be under? I can use ${suggested} if that's you.`
        : 'What name should the booking be under?';
    return ctx.client.sendText(ctx.waId, withPrefix(prefix, question));
}

export function askPhone(ctx, prefix) {
    return ctx.client.sendText(
        ctx.waId,
        withPrefix(prefix, `Shall I use your WhatsApp number ending ${String(ctx.waId).slice(-4)} as the contact number, or would you like to share another?`)
    );
}

export function askGuests(ctx, prefix) {
    return ctx.client.sendText(ctx.waId, withPrefix(prefix, 'And how many people will be joining you?'));
}

export function askGuestsMore(ctx, prefix) {
    return ctx.client.sendText(ctx.waId, withPrefix(prefix, `Please type the number of guests (10 to ${MAX_GUESTS}).`));
}

export function askDate(ctx, today, prefix) {
    return ctx.client.sendText(
        ctx.waId,
        withPrefix(prefix, `Perfect! What date would you like to visit? You can say tomorrow, Thursday, or a date like 25/12.`)
    );
}

/** Opening-hour suggestions as readable text — seats are confirmed separately. */
export function askTime(ctx, date, times, prefix) {
    const labels = (times || []).slice(0, 9).map((hm, i) => `${i + 1}. ${formatTime12(hm)}`);
    const hours = labels.length
        ? `\n\nTimes that fall inside opening hours that day:\n${labels.join('\n')}\n\nReply with a number or a time. I'll confirm a table once you choose.`
        : ' You can type a time such as 7:30 PM.';
    return ctx.client.sendText(
        ctx.waId,
        withPrefix(prefix, `What time on ${formatDateShort(date)} would you like?${hours}`)
    );
}

export function askRequests(ctx, prefix) {
    return ctx.client.sendText(ctx.waId, withPrefix(prefix, 'Any special requests or allergies I should note? If not, just say none.'));
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
        'Great news! Your reservation is confirmed.',
        '',
        `🍽️ Restaurant: ${restaurant.name}`,
        `👤 Name: ${data.name}`,
        `📅 Date: ${formatDateLong(data.date)}`,
        `🕒 Time: ${formatTime12(data.time)}`,
        `👥 Guests: ${data.guests}`,
    ];
    if (data.requests) lines.push(`📝 Requests: ${data.requests}`);
    lines.push(`🎟️ Reference: ${String(result.paymentId).slice(0, 8).toUpperCase()}`);

    if (result.paymentLink) {
        lines.push(
            '',
            `To secure the table, please pay the deposit of ${formatMoney(result.bookingAmount, restaurant.currency)}:`,
            result.paymentLink
        );
    } else {
        lines.push('', 'We look forward to welcoming you!');
    }
    lines.push('', 'If you need to make any changes, just send me a message.');
    return lines.join('\n');
}

export function cancelledText() {
    return 'Your booking request has been cancelled. Send "hi" whenever you\'d like to start again.';
}

export function unsupportedText() {
    return 'Sorry, I can only read text messages and button taps for now. Please type your answer or use the options.';
}
