import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    handleMessage,
    normalisePhoneInput,
    parseGuests,
    validateName,
} from '../../src/services/whatsapp/whatsappHandlers.js';
import { REPLY, STEP } from '../../src/services/whatsapp/whatsappSteps.js';
import { bodyOf, fakeCtx, idsOf, reply, text, WA_ID } from './helpers.js';

/** Sends inputs one after another, carrying the session like the processor does. */
async function run(ctx, inputs, start = null) {
    let session = start;
    for (const input of inputs) {
        session = await handleMessage(input, session, ctx);
    }
    return session;
}

const TO_CONFIRM = [
    text('hi'),
    reply(REPLY.BOOK),
    text('Thandi Mokoena'),
    reply(REPLY.PHONE_WHATSAPP),
    reply('guests:4'),
    reply('date:2026-10-30'),
    reply('time:19:00'),
    reply(REPLY.NO_REQUESTS),
];

describe('welcome', () => {
    it('"hi" sends the welcome as a "Choose an option" list', async () => {
        const { ctx, client } = fakeCtx();
        const session = await run(ctx, [text('hi')]);

        assert.equal(session.step, STEP.WELCOME);
        const message = client.last();
        const [body, buttonText, rows, sectionTitle] = message.args;
        assert.equal(message.type, 'list');
        assert.equal(message.to, WA_ID);
        assert.match(body, /Welcome to Billy's Steakhouse/);
        assert.equal(buttonText, 'Choose an option');
        assert.equal(sectionTitle, 'What can I help with?');
        assert.deepEqual(idsOf(message), [REPLY.BOOK, REPLY.VIEW_MENU, REPLY.CONTACT]);
        assert.deepEqual(rows.map((r) => r.title), ['🍽️ Book a Table', '📖 View Menu', '📞 Contact Us']);
        assert.ok(rows.every((r) => r.title.length <= 24 && r.description && r.description.length <= 72));
    });

    it('View Menu sends MENU_URL, Contact Us sends CONTACT_INFO', async () => {
        const { ctx, client } = fakeCtx();
        await run(ctx, [text('hi'), reply(REPLY.VIEW_MENU)]);
        assert.ok(client.sent.some((m) => m.type === 'text' && bodyOf(m).includes('https://example.com/menu')));

        await run(ctx, [reply(REPLY.CONTACT)]);
        assert.ok(client.sent.some((m) => m.type === 'text' && bodyOf(m).includes('+27 21 000 0000')));
        assert.equal(client.last().type, 'list');
    });

    it('any text with no session gets the welcome', async () => {
        const { ctx, client } = fakeCtx();
        const session = await run(ctx, [text('do you have parking?')]);
        assert.equal(session.step, STEP.WELCOME);
        assert.deepEqual(idsOf(client.last()), [REPLY.BOOK, REPLY.VIEW_MENU, REPLY.CONTACT]);
    });
});

describe('happy path', () => {
    it('collects every field, shows a summary, books and sends the payment link', async () => {
        const { ctx, client, saved, booked } = fakeCtx();
        const atConfirm = await run(ctx, TO_CONFIRM);

        assert.equal(atConfirm.step, STEP.CONFIRM);
        assert.deepEqual(atConfirm.data, {
            suggestedName: 'Thandi Mokoena',
            name: 'Thandi Mokoena',
            phone: `+${WA_ID}`,
            guests: 4,
            date: '2026-10-30',
            offeredTimes: ['18:00', '19:00', '20:00'],
            time: '19:00',
            sittingId: 7,
            requests: '',
        });

        const summary = client.last();
        assert.equal(summary.type, 'buttons');
        assert.deepEqual(idsOf(summary), [REPLY.CONFIRM, REPLY.START_OVER, REPLY.CANCEL]);
        assert.match(bodyOf(summary), /Friday, 30 October 2026/);
        assert.match(bodyOf(summary), /7:00 PM/);
        assert.match(bodyOf(summary), /R400\.00/);

        const done = await run(ctx, [reply(REPLY.CONFIRM)], atConfirm);
        assert.equal(done.step, STEP.DONE);
        assert.equal(done.lastBooking.paymentId, 'abcd1234-0000-0000-0000-000000000000');

        assert.equal(booked.length, 1);
        assert.equal(booked[0].restaurant.id, '1');
        assert.equal(booked[0].waId, WA_ID);

        const confirmation = client.last();
        assert.equal(confirmation.type, 'text');
        assert.match(bodyOf(confirmation), /confirmed/);
        assert.match(bodyOf(confirmation), /https:\/\/payment\.booki\.co\.za\/payment\/abcd1234/);
        assert.match(bodyOf(confirmation), /ABCD1234/);

        assert.equal(saved.length, 1);
        assert.equal(saved[0].waId, WA_ID);
        assert.equal(saved[0].data.phone, `+${WA_ID}`);
    });

    it('accepts typed answers', async () => {
        const { ctx } = fakeCtx({ profileName: null });
        const session = await run(ctx, [
            text('hi'), reply(REPLY.BOOK),
            text('  Jean-Luc  Picard '),
            text('082 123 4567'),
            text('2 people'),
            text('30/10'),
            text('7pm'),
            text('Window seat, nut allergy'),
        ]);
        assert.equal(session.step, STEP.CONFIRM);
        assert.equal(session.data.name, 'Jean-Luc Picard');
        assert.equal(session.data.phone, '+27821234567');
        assert.equal(session.data.guests, 2);
        assert.equal(session.data.date, '2026-10-30');
        assert.equal(session.data.time, '19:00');
        assert.equal(session.data.requests, 'Window seat, nut allergy');
    });

    it('confirmation without a deposit has no payment link', async () => {
        const { ctx, client } = fakeCtx();
        ctx.booking.book = async () => ({ status: 'booked', paymentId: 'p-1', bookingAmount: 0, paymentLink: null });
        const atConfirm = await run(ctx, TO_CONFIRM);
        await run(ctx, [reply(REPLY.CONFIRM)], atConfirm);
        assert.doesNotMatch(bodyOf(client.last()), /payment/i);
        assert.match(bodyOf(client.last()), /look forward/);
    });

    it('offers a known name (WhatsApp profile or earlier booking) as a button', async () => {
        const { ctx, client } = fakeCtx({ profileName: null });
        ctx.contacts.getKnownName = async () => 'Sipho Dlamini';
        const session = await run(ctx, [text('hi'), reply(REPLY.BOOK)]);
        assert.equal(session.step, STEP.NAME);
        assert.deepEqual(idsOf(client.last()), [REPLY.NAME_SUGGESTED]);
        assert.ok(client.last().args[1][0].title.startsWith('Use Sipho'));

        const next = await run(ctx, [reply(REPLY.NAME_SUGGESTED)], session);
        assert.equal(next.data.name, 'Sipho Dlamini');
        assert.equal(next.step, STEP.PHONE);
    });
});

describe('validation re-asks and keeps the step', () => {
    const cases = [
        ['name', [text('hi'), reply(REPLY.BOOK)], text('12345'), STEP.NAME],
        ['phone', [text('hi'), reply(REPLY.BOOK), text('Thandi')], text('12'), STEP.PHONE],
        ['guests (zero)', [text('hi'), reply(REPLY.BOOK), text('Thandi'), reply(REPLY.PHONE_WHATSAPP)], text('0'), STEP.GUESTS],
        ['guests (words)', [text('hi'), reply(REPLY.BOOK), text('Thandi'), reply(REPLY.PHONE_WHATSAPP)], text('a few'), STEP.GUESTS],
        ['date (impossible)', TO_CONFIRM.slice(0, 5), text('31/02'), STEP.DATE],
        ['date (past)', TO_CONFIRM.slice(0, 5), text('2026-10-01'), STEP.DATE],
        ['date (too far)', TO_CONFIRM.slice(0, 5), text('2027-12-01'), STEP.DATE],
        ['time', TO_CONFIRM.slice(0, 6), text('25:00'), STEP.TIME],
        ['requests (too long)', TO_CONFIRM.slice(0, 7), text('x'.repeat(301)), STEP.REQUESTS],
        ['confirm (free text)', TO_CONFIRM, text('yes please'), STEP.CONFIRM],
    ];

    for (const [label, setup, bad, step] of cases) {
        it(label, async () => {
            const { ctx, client } = fakeCtx();
            const before = await run(ctx, setup);
            const sentBefore = client.sent.length;
            const after = await run(ctx, [bad], before);
            assert.equal(after.step, step);
            assert.deepEqual(after.data, before.data);
            assert.ok(client.sent.length > sentBefore, 'a re-ask message is sent');
        });
    }

    it('a time too soon today is rejected', async () => {
        const { ctx, client } = fakeCtx();
        // now is 10:00 in Johannesburg
        const session = await run(ctx, [...TO_CONFIRM.slice(0, 5), reply('date:2026-10-27'), text('10:15')]);
        assert.equal(session.step, STEP.TIME);
        assert.match(bodyOf(client.last()), /too soon/);
    });

    it('a closed date asks for another date', async () => {
        const { ctx, client } = fakeCtx();
        const session = await run(ctx, [...TO_CONFIRM.slice(0, 5), reply('date:2026-10-31')]);
        assert.equal(session.step, STEP.DATE);
        assert.match(bodyOf(client.last()), /closed/);
        assert.match(bodyOf(client.last()), /Private Event/);
    });
});

describe('guests', () => {
    it('"10 or more" asks for a number, then continues to date', async () => {
        const { ctx } = fakeCtx();
        const more = await run(ctx, [...TO_CONFIRM.slice(0, 4), reply(REPLY.GUESTS_MORE)]);
        assert.equal(more.step, STEP.GUESTS_MORE);
        const next = await run(ctx, [text('12')], more);
        assert.equal(next.step, STEP.DATE);
        assert.equal(next.data.guests, 12);
    });

    it('a party above the limit is pointed to the restaurant', async () => {
        const { ctx, client } = fakeCtx();
        const session = await run(ctx, [...TO_CONFIRM.slice(0, 4), text('100')]);
        assert.equal(session.step, STEP.GUESTS);
        assert.ok(client.sent.some((m) => m.type === 'text' && /larger than 30/.test(bodyOf(m))));
    });
});

describe('availability', () => {
    it('a full time offers other times', async () => {
        const { ctx, client } = fakeCtx();
        const session = await run(ctx, [...TO_CONFIRM.slice(0, 6), reply('time:20:00')]);
        assert.equal(session.step, STEP.TIME);
        assert.deepEqual(session.data.offeredTimes, ['18:00', '19:00']);
        assert.equal(session.data.time, null);
        const offer = client.last();
        assert.equal(offer.type, 'list');
        assert.deepEqual(idsOf(offer), ['time:18:00', 'time:19:00', REPLY.OTHER_DATE]);
        assert.match(bodyOf(offer), /fully booked/);
        assert.match(bodyOf(offer), /Only 2 seats are left/);
    });

    it('no alternatives sends the guest back to choose a date', async () => {
        const { ctx, client } = fakeCtx();
        ctx.booking.findAlternatives = async () => [];
        const session = await run(ctx, [...TO_CONFIRM.slice(0, 6), reply('time:20:00')]);
        assert.equal(session.step, STEP.DATE);
        assert.match(bodyOf(client.last()), /no other times/);
    });

    it('slot taken at Confirm offers other times and does not book', async () => {
        const { ctx, client } = fakeCtx();
        ctx.booking.book = async () => ({ status: 'unavailable', check: { ok: false, reason: 'full', seatsLeft: 0 } });
        const atConfirm = await run(ctx, TO_CONFIRM);
        const session = await run(ctx, [reply(REPLY.CONFIRM)], atConfirm);
        assert.equal(session.step, STEP.TIME);
        assert.deepEqual(idsOf(client.last()), ['time:18:00', 'time:19:00', REPLY.OTHER_DATE]);
    });

    it('a booking error keeps the summary so the guest can retry', async () => {
        const { ctx, client, saved } = fakeCtx();
        ctx.booking.book = async () => ({ status: 'error', error: 'boom' });
        const atConfirm = await run(ctx, TO_CONFIRM);
        const session = await run(ctx, [reply(REPLY.CONFIRM)], atConfirm);
        assert.equal(session.step, STEP.CONFIRM);
        assert.deepEqual(idsOf(client.last()), [REPLY.CONFIRM, REPLY.START_OVER, REPLY.CANCEL]);
        assert.match(bodyOf(client.last()), /couldn't save/);
        assert.equal(saved.length, 0);
    });
});

describe('global commands and edge cases', () => {
    it('"cancel" clears the session mid-flow', async () => {
        const { ctx, client } = fakeCtx();
        const session = await run(ctx, [...TO_CONFIRM.slice(0, 4), text('Cancel')]);
        assert.equal(session, null);
        assert.match(bodyOf(client.last()), /cancelled/);
    });

    it('"menu" and "restart" return to the welcome mid-flow', async () => {
        for (const word of ['menu', 'restart']) {
            const { ctx, client } = fakeCtx();
            const session = await run(ctx, [...TO_CONFIRM.slice(0, 5), text(word)]);
            assert.equal(session.step, STEP.WELCOME);
            assert.deepEqual(session.data, {});
            assert.deepEqual(idsOf(client.last()), [REPLY.BOOK, REPLY.VIEW_MENU, REPLY.CONTACT]);
        }
    });

    it('Cancel and Start over on the summary', async () => {
        const { ctx } = fakeCtx();
        const atConfirm = await run(ctx, TO_CONFIRM);
        assert.equal(await run(ctx, [reply(REPLY.CANCEL)], atConfirm), null);

        const restarted = await run(ctx, [reply(REPLY.START_OVER)], atConfirm);
        assert.equal(restarted.step, STEP.NAME);
        assert.deepEqual(restarted.data, { suggestedName: 'Thandi Mokoena' });
    });

    it('unsupported media gets a polite reply and the same question again', async () => {
        const { ctx, client } = fakeCtx();
        const before = await run(ctx, TO_CONFIRM.slice(0, 4));
        const after = await run(ctx, [{ type: 'unsupported', kind: 'image' }], before);
        assert.equal(after.step, STEP.GUESTS);
        assert.match(bodyOf(client.last()), /only read text/);
        assert.equal(client.last().type, 'list');
    });

    it('a stale button from an old message re-asks the current step', async () => {
        const { ctx } = fakeCtx();
        const before = await run(ctx, TO_CONFIRM.slice(0, 3));
        const after = await run(ctx, [reply('guests:4')], before);
        assert.equal(after.step, STEP.PHONE);
    });

    it('a session idle for over 24 hours starts fresh', async () => {
        const { ctx } = fakeCtx();
        const old = { step: STEP.CONFIRM, restaurantId: '1', data: { name: 'Old' }, updatedAt: new Date('2026-10-25T08:00:00Z') };
        const session = await run(ctx, [reply(REPLY.CONFIRM)], old);
        assert.equal(session.step, STEP.WELCOME);
    });

    it('a session for another restaurant starts fresh', async () => {
        const { ctx } = fakeCtx();
        const other = { step: STEP.CONFIRM, restaurantId: '99', data: { name: 'Old' } };
        const session = await run(ctx, [reply(REPLY.CONFIRM)], other);
        assert.equal(session.step, STEP.WELCOME);
    });

    it('after a booking, the next message shows the welcome again', async () => {
        const { ctx } = fakeCtx();
        const atConfirm = await run(ctx, TO_CONFIRM);
        const done = await run(ctx, [reply(REPLY.CONFIRM)], atConfirm);
        const next = await run(ctx, [text('thanks')], done);
        assert.equal(next.step, STEP.WELCOME);
    });
});

describe('validators', () => {
    it('validateName', () => {
        assert.equal(validateName('Thandi'), 'Thandi');
        assert.equal(validateName("Zoë O'Neil"), "Zoë O'Neil");
        assert.equal(validateName('A'), null);
        assert.equal(validateName('R2D2'), null);
        assert.equal(validateName('x'.repeat(61)), null);
    });

    it('normalisePhoneInput', () => {
        assert.equal(normalisePhoneInput('082 123 4567', WA_ID), '+27821234567');
        assert.equal(normalisePhoneInput('+27 82 123 4567', WA_ID), '+27821234567');
        assert.equal(normalisePhoneInput('0027821234567', WA_ID), '+27821234567');
        assert.equal(normalisePhoneInput('821234567', WA_ID), '+27821234567');
        assert.equal(normalisePhoneInput('8319377879', '918319377879'), '+918319377879');
        assert.equal(normalisePhoneInput('12345', WA_ID), null);
        assert.equal(normalisePhoneInput('call me', WA_ID), null);
    });

    it('parseGuests', () => {
        assert.equal(parseGuests('4'), 4);
        assert.equal(parseGuests('6 guests'), 6);
        assert.equal(parseGuests('four'), null);
    });
});
