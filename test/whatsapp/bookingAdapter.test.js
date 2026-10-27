import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createBookingAdapter, evaluateCapacity } from '../../src/services/whatsapp/whatsappBookingAdapter.js';
import { RESTAURANT, WA_ID } from './helpers.js';

const open = (seatsLeft, sittingId = 7) => ({
    isOpen: true,
    checkFailed: false,
    needsTime: false,
    sittingId,
    available: seatsLeft,
    matches: [{ sittingId, sittingName: 'Dinner', sittingCapacity: 40, bookedGuests: 40 - seatsLeft, seatsLeft, unlimited: false }],
});

const DATA = {
    name: 'Thandi Mokoena',
    phone: '+27821234567',
    guests: 4,
    date: '2026-10-30',
    time: '19:00',
    requests: 'Nut allergy',
    sittingId: 7,
};

function adapter({ capacity = () => open(20), createManualBooking, alsoSendSms = false } = {}) {
    const calls = { capacity: [], booking: [] };
    const instance = createBookingAdapter({
        getAvailableCapacityForDate: async (...args) => {
            calls.capacity.push(args);
            return capacity(args[3]);
        },
        createManualBooking: createManualBooking || (async (...args) => {
            calls.booking.push(args);
            return { success: true, paymentId: 'pay-123' };
        }),
        paymentBaseUrl: 'https://payment.booki.co.za',
        getConfig: () => ({ alsoSendSms }),
    });
    return { instance, calls };
}

describe('evaluateCapacity', () => {
    it('fails open when the check could not run (same as the voice tool)', () => {
        assert.deepEqual(evaluateCapacity({ checkFailed: true }, 4), { ok: true, sittingId: null, failOpen: true });
    });

    it('closed time', () => {
        const result = evaluateCapacity({ isOpen: false, closedReason: 'Closed for Christmas Day', matches: [] }, 2);
        assert.deepEqual(result, { ok: false, reason: 'closed', message: 'Closed for Christmas Day' });
    });

    it('not enough seats', () => {
        assert.deepEqual(evaluateCapacity(open(2), 4), { ok: false, reason: 'full', seatsLeft: 2 });
    });

    it('enough seats returns the sitting id', () => {
        assert.deepEqual(evaluateCapacity(open(4), 4), { ok: true, sittingId: 7 });
    });

    it('unlimited sitting', () => {
        const capacity = { isOpen: true, sittingId: 3, available: null, matches: [{ sittingId: 3, seatsLeft: null, unlimited: true }] };
        assert.deepEqual(evaluateCapacity(capacity, 50), { ok: true, sittingId: 3 });
    });
});

describe('book → existing createManualBooking', () => {
    it('re-checks the slot, then calls the existing booking function with WhatsApp options', async () => {
        const { instance, calls } = adapter();
        const result = await instance.book({ restaurant: RESTAURANT, waId: WA_ID, data: DATA });

        assert.equal(calls.capacity.length, 1);
        assert.deepEqual(calls.capacity[0], [null, '1', '2026-10-30', '19:00']);

        assert.equal(calls.booking.length, 1);
        assert.deepEqual(calls.booking[0], [
            '1',
            {
                name: 'Thandi Mokoena',
                phoneNo: '+27821234567',
                guests: 4,
                date: '2026-10-30',
                time: '19:00',
                notes: 'Nut allergy',
            },
            {
                source: 'whatsapp',
                sittingId: 7,
                skipSms: true,
                extraFields: { channel: 'whatsapp', whatsappNumber: `+${WA_ID}` },
            },
        ]);

        assert.deepEqual(result, {
            status: 'booked',
            paymentId: 'pay-123',
            bookingAmount: 400,
            paymentLink: 'https://payment.booki.co.za/payment/pay-123',
        });
    });

    it('WA_ALSO_SEND_SMS=true keeps the SMS', async () => {
        const { instance, calls } = adapter({ alsoSendSms: true });
        await instance.book({ restaurant: RESTAURANT, waId: WA_ID, data: DATA });
        assert.equal(calls.booking[0][2].skipSms, false);
    });

    it('no deposit → no payment link (same rule as the SMS)', async () => {
        const { instance } = adapter();
        const result = await instance.book({ restaurant: { ...RESTAURANT, depositAmount: 0 }, waId: WA_ID, data: DATA });
        assert.equal(result.bookingAmount, 0);
        assert.equal(result.paymentLink, null);
    });

    it('slot taken since it was chosen → unavailable, nothing booked', async () => {
        const { instance, calls } = adapter({ capacity: () => open(1) });
        const result = await instance.book({ restaurant: RESTAURANT, waId: WA_ID, data: DATA });
        assert.equal(result.status, 'unavailable');
        assert.equal(result.check.reason, 'full');
        assert.equal(calls.booking.length, 0);
    });

    it('booking function throws → error result, no crash', async () => {
        const { instance } = adapter({ createManualBooking: async () => { throw new Error('Firestore down'); } });
        const result = await instance.book({ restaurant: RESTAURANT, waId: WA_ID, data: DATA });
        assert.deepEqual(result, { status: 'error', error: 'Firestore down' });
    });

    it('capacity API down → books anyway without a sitting from the check', async () => {
        const { instance, calls } = adapter({ capacity: () => ({ checkFailed: true }) });
        const result = await instance.book({ restaurant: RESTAURANT, waId: WA_ID, data: DATA });
        assert.equal(result.status, 'booked');
        assert.equal(calls.booking[0][2].sittingId, 7);
    });
});

describe('findAlternatives', () => {
    it('returns up to 3 nearest times that fit, in time order', async () => {
        const seats = { '17:00': 10, '18:00': 1, '18:30': 10, '19:30': 10, '20:00': 10, '21:00': 10 };
        const { instance } = adapter({ capacity: (time) => open(seats[time] ?? 0) });
        const result = await instance.findAlternatives('1', '2026-10-30', '19:00', 4,
            ['17:00', '18:00', '18:30', '19:00', '19:30', '20:00', '21:00']);
        assert.deepEqual(result, ['18:30', '19:30', '20:00']);
    });

    it('skips times whose check failed', async () => {
        const { instance } = adapter({ capacity: (time) => (time === '18:00' ? { checkFailed: true } : open(10)) });
        const result = await instance.findAlternatives('1', '2026-10-30', '19:00', 2, ['18:00', '20:00']);
        assert.deepEqual(result, ['20:00']);
    });
});
