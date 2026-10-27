// Shared fakes for the WhatsApp tests. No Firestore, no network.

export const WA_ID = '27821234567';

// 10:00 in Johannesburg on Tue 27 Oct 2026
export const NOW = new Date('2026-10-27T08:00:00Z');

export const RESTAURANT = {
    id: '1',
    name: "Billy's Steakhouse",
    timezone: 'Africa/Johannesburg',
    currency: 'ZAR',
    depositAmount: 100,
    operatingHours: null,
};

export function fakeClient() {
    const sent = [];
    const record = (type) => async (to, ...args) => {
        sent.push({ type, to, args });
        return { ok: true };
    };
    return {
        sent,
        last: () => sent[sent.length - 1],
        sendText: record('text'),
        sendButtons: record('buttons'),
        sendList: record('list'),
        sendTemplate: record('template'),
        markRead: async () => ({ ok: true }),
    };
}

/** Body text of a sent message (any type). */
export function bodyOf(message) {
    return message?.args?.[0] || '';
}

/** Reply ids offered by a sent buttons/list message. */
export function idsOf(message) {
    if (message?.type === 'buttons') return message.args[1].map((b) => b.id);
    if (message?.type === 'list') return message.args[2].map((r) => r.id);
    return [];
}

export function fakeCtx(overrides = {}) {
    const client = fakeClient();
    const saved = [];
    const booked = [];
    const ctx = {
        waId: WA_ID,
        profileName: 'Thandi Mokoena',
        restaurant: RESTAURANT,
        client,
        config: { menuUrl: 'https://example.com/menu', contactInfo: '+27 21 000 0000' },
        now: NOW,
        availability: {
            async getDaySlots(_restaurant, date) {
                if (date === '2026-10-31') return { closed: true, reason: 'closed for Private Event', times: [] };
                return { closed: false, reason: null, times: ['18:00', '19:00', '20:00'] };
            },
        },
        booking: {
            async checkSlot(_id, _date, time) {
                if (time === '20:00') return { ok: false, reason: 'full', seatsLeft: 2 };
                return { ok: true, sittingId: 7 };
            },
            async findAlternatives() {
                return ['18:00', '19:00'];
            },
            async book(args) {
                booked.push(args);
                return {
                    status: 'booked',
                    paymentId: 'abcd1234-0000-0000-0000-000000000000',
                    bookingAmount: Number(args.data.guests) * 100,
                    paymentLink: 'https://payment.booki.co.za/payment/abcd1234-0000-0000-0000-000000000000',
                };
            },
        },
        contacts: {
            async getKnownName() { return null; },
            async saveBooking(args) { saved.push(args); },
        },
        ...overrides,
    };
    return { ctx, client, saved, booked };
}

export const text = (value) => ({ type: 'text', text: value });
export const reply = (id) => ({ type: 'reply', id, title: id });
