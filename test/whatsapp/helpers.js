// Shared fakes for the WhatsApp tests. No Firestore, no network.

import { bookiHostRestaurant, matchRestaurants } from '../../src/services/whatsapp/whatsappRestaurantDirectory.js';

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

export const DIRECTORY = [
    { id: '1', name: "Billy's Steakhouse", area: 'Cape Town', address: 'V&A Waterfront', province: 'Western Cape', postalCode: '8001', description: 'Steakhouse', phone: '+27210000001' },
    { id: '2', name: "Ryan's Restaurant", area: 'Stellenbosch', address: '12 Church Street', province: 'Western Cape', postalCode: '7600', description: 'Wine bar', phone: '+27210000002' },
    { id: '3', name: "Bjorn's Steakhouse", area: 'Cape Town', address: '12 Long Street', province: 'Western Cape', postalCode: '8000', description: 'Steakhouse', phone: '+27210000003' },
    { id: '4', name: 'La Petite Maison', area: 'Franschhoek', address: '1 Huguenot Street', province: 'Western Cape', postalCode: '7690', description: '', phone: '+27210000004' },
    { id: '5', name: 'The Test Kitchen', area: 'Cape Town', address: '375 Albert Road, Woodstock', province: 'Western Cape', postalCode: '7925', description: '', phone: '+27210000005' },
];

export function fakeDirectory(entries = DIRECTORY) {
    return {
        async list() { return entries; },
        async getById(id) { return entries.find((entry) => entry.id === String(id)) || null; },
        async suggest(location) { return matchRestaurants(entries, location); },
    };
}

export function fakeLoadRestaurant(entries = DIRECTORY) {
    return async (id) => {
        const entry = entries.find((row) => row.id === String(id));
        if (!entry) return null;
        return {
            id: entry.id,
            name: entry.name,
            timezone: 'Africa/Johannesburg',
            currency: 'ZAR',
            depositAmount: 50,
            operatingHours: null,
        };
    };
}

export function pickerOverrides(entries = DIRECTORY) {
    const host = bookiHostRestaurant({ timezone: 'Africa/Johannesburg' });
    return {
        restaurant: host,
        directory: fakeDirectory(entries),
        loadRestaurant: fakeLoadRestaurant(entries),
        hostRestaurant: () => host,
    };
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
