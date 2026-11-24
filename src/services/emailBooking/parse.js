import { addDays, dayNameFor, formatDateLong, formatTime12, parseDateInput, parseTimeInput, todayInTz, WEEK_DAYS } from '../whatsapp/whatsappDateTime.js';

const BOOKING_WORDS = /\b(book|booking|reserve|reservation|table|availability|available|party|guests?|cancel|cancellation)\b/i;
const NOISE = /\b(unsubscribe|newsletter|promotion|promo code|no-reply|noreply|mailer-daemon)\b/i;

export function classifyEmail({ subject = '', body = '' }) {
    const text = `${subject}\n${freshEmailText(body)}`;
    if (NOISE.test(text) && !BOOKING_WORDS.test(text)) return 'ignore';
    if (/^\s*(please\s+)?(cancel|cancellation)\b/i.test(freshEmailText(body))) return 'review';
    if (BOOKING_WORDS.test(text)) return 'booking';
    return 'review';
}

export function freshEmailText(body) {
    return htmlToText(body)
        .split(/\nOn [^\n]{0,180}wrote:\s*/i)[0]
        .split(/\n?\s*\[image: Mailsuite\]/i)[0]
        .split(/\nSender notified with Mailtrack/i)[0]
        .replace(/(?:^|\n)\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}:\d{2}\s*(?=\n|$)/g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('>'))
        .join('\n')
        .trim();
}

export function extractBookingDetails(text, today = new Date()) {
    return readDetails(freshEmailText(text), asDay(today));
}

export function mergeDraft(existing, extracted, guestName) {
    return {
        date: extracted?.date || existing?.date || null,
        time: extracted?.time || existing?.time || null,
        guests: extracted?.guests || existing?.guests || null,
        phone: extracted?.phone || existing?.phone || null,
        name: guestName || existing?.name || 'Guest',
        paymentId: existing?.paymentId || null,
    };
}

export function isConfirmation(text) {
    const fresh = freshEmailText(text);
    return /^\s*(yes|yeah|yep|confirm|confirmed|please book|book it|that works|go ahead)\b/i.test(fresh);
}

export function missingFields(details) {
    return ['date', 'time', 'guests', 'phone'].filter((field) => !details?.[field]);
}

export function guestNameFrom(fromHeader, body) {
    const display = String(fromHeader || '').match(/^(.*?)</);
    const headerName = (display ? display[1] : '').replace(/"/g, '').trim();
    if (headerName && !headerName.includes('@')) return headerName;
    const signed = freshEmailText(body).match(/(?:best regards|kind regards|regards|sincerely),?\s*\n+\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
    return signed?.[1] || 'Guest';
}

export function composeReply({ restaurantName, guestName, draft, missing = [], availability, paymentId, bookingId, today }) {
    const signOff = ['Kind regards,', restaurantName || 'Reservations'].join('\n');
    const greeting = `Dear ${firstName(guestName)},`;
    if (paymentId || bookingId) {
        return [
            greeting,
            '',
            'Your reservation is confirmed.',
            '',
            detailBlock(draft),
            ...(bookingId ? ['', `Booking ID: ${bookingId}`] : []),
            '',
            'We look forward to welcoming you.',
            '',
            signOff,
        ].join('\n');
    }
    if (draft?.date && today && draft.date < today) {
        return [
            greeting,
            '',
            'Thank you for your email.',
            '',
            `The date in your message, ${formatDateLong(draft.date)}, has already passed. Please reply with another date and we will check availability.`,
            '',
            signOff,
        ].join('\n');
    }
    const paragraphs = ['Thank you for your email.', ''];
    const noted = notedSentence(draft);
    if (noted) paragraphs.push(noted, '');
    if (availability === 'unavailable') {
        paragraphs.push(`We do not have a table available at ${formatTime12(draft.time)} on ${formatDateLong(draft.date)}. Please reply with another date or time and we will check it for you.`);
    } else {
        if (availability === 'open') paragraphs.push('We have availability for this reservation.', '');
        if (missing.length) paragraphs.push(`Could you please let us know ${missingPhrase(missing)}?`);
        else if (availability === 'open') paragraphs.push('Please reply YES and we will confirm this reservation. If you would like a different time, reply with the change.');
    }
    return [greeting, '', ...paragraphs, '', signOff].join('\n');
}

function readDetails(text, today) {
    return {
        guests: extractGuests(text),
        time: extractTime(text),
        date: extractDate(text, today),
        phone: extractPhone(text),
    };
}

function extractGuests(text) {
    const patterns = [
        /\b(?:table\s+for|party\s+of|for)\s+(\d{1,2})\s*(?:people|persons?|guests?|pax)\b/i,
        /\b(\d{1,2})\s*(?:people|persons?|guests?|pax)\b/i,
        /\btable\s+for\s+(\d{1,2})\b/i,
    ];
    for (const pattern of patterns) {
        const match = text.match(pattern);
        const guests = Number(match?.[1]);
        if (guests >= 1 && guests <= 30) return guests;
    }
    return null;
}

function extractTime(text) {
    const match = text.match(/\b(?:at|@)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)\b/i)
        || text.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.))\b/i);
    if (!match) return null;
    const parsed = parseTimeInput(match[1]);
    return parsed && /am|pm|a\.m|p\.m|at|@/i.test(match[0]) ? parsed : null;
}

function extractDate(text, today) {
    const explicit = firstParsed(text, [
        /\b(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}(?:\s+\d{4})?)\b/gi,
        /\b([A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)\b/gi,
        /\b(20\d{2}-\d{2}-\d{2})\b/g,
        /\b(\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?)\b/g,
    ], today);
    if (explicit) return explicit;
    if (/\btomorrow\b/i.test(text)) return addDays(today, 1);
    if (/\btoday\b/i.test(text)) return today;
    const weekday = text.toLowerCase().match(/\b(?:(this|next)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
    if (!weekday) return null;
    const target = WEEK_DAYS.findIndex((day) => day.toLowerCase() === weekday[2]);
    const current = WEEK_DAYS.indexOf(dayNameFor(today));
    let delta = (target - current + 7) % 7;
    if (weekday[1] === 'next' && delta === 0) delta = 7;
    if (!weekday[1] && delta === 0) delta = 7;
    return addDays(today, delta);
}

function firstParsed(text, patterns, today) {
    for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
            const parsed = parseDateInput(match[1].replace(/,/g, ''), today);
            if (parsed) return parsed;
        }
    }
    return null;
}

function extractPhone(text) {
    const labeled = text.match(/(?:phone|mobile|cell|whatsapp|contact)(?:\s+number|\s+no\.?)?\s*(?:is|:)?\s*(\+?\d[\d\s().-]{6,22}\d)/i);
    const plus = text.match(/(\+\d[\d\s().-]{7,22}\d)/);
    const bare = text.match(/(?:^|[^\d])(\d{10,15})(?!\d)/);
    return cleanPhone(labeled?.[1] || plus?.[1] || bare?.[1]);
}

function cleanPhone(value) {
    if (!value) return null;
    const compact = String(value).replace(/[^\d+]/g, '');
    const digits = compact.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) return null;
    if (/^20\d{2}/.test(digits) && digits.length <= 8) return null;
    return compact;
}

function notedSentence(draft) {
    const parts = [];
    if (draft?.guests) parts.push(`a table for ${draft.guests}`);
    if (draft?.date) parts.push(`on ${formatDateLong(draft.date)}`);
    if (draft?.time) parts.push(`at ${formatTime12(draft.time)}`);
    if (!parts.length && !draft?.phone) return '';
    const noted = parts.length ? `We have noted your request for ${parts.join(' ')}.` : 'Thank you for the details.';
    return draft?.phone ? `${noted} We have your phone number.` : noted;
}

function detailBlock(draft) {
    return [
        draft?.date ? `Date: ${formatDateLong(draft.date)}` : '',
        draft?.time ? `Time: ${formatTime12(draft.time)}` : '',
        draft?.guests ? `Guests: ${draft.guests}` : '',
    ].filter(Boolean).join('\n');
}

function missingPhrase(missing) {
    const labels = {
        date: 'the date you would like',
        time: 'the time you would like to arrive',
        guests: 'how many guests will be joining',
        phone: 'a phone number we can reach you on',
    };
    const words = missing.map((field) => labels[field]);
    if (words.length === 1) return words[0];
    return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

function firstName(name) {
    const clean = String(name || '').replace(/"/g, '').trim();
    if (!clean || clean === 'Guest' || clean.includes('@')) return 'Guest';
    return clean.split(/\s+/)[0];
}

function asDay(today) {
    if (typeof today === 'string' && /^\d{4}-\d{2}-\d{2}/.test(today)) return today.slice(0, 10);
    return todayInTz('Africa/Johannesburg', today instanceof Date ? today : new Date());
}

function htmlToText(value) {
    return String(value || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .trim();
}
