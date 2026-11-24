import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEmail, composeReply, extractBookingDetails, isConfirmation, mergeDraft, missingFields } from '../../src/services/emailBooking/parse.js';

const TODAY = '2026-11-23';

test('classifies a booking request and ignores a newsletter', () => {
    assert.equal(classifyEmail({ subject: 'Table', body: 'I want to book a table tomorrow' }), 'booking');
    assert.equal(classifyEmail({ subject: 'Weekly newsletter', body: 'Unsubscribe from this promotion' }), 'ignore');
    assert.equal(classifyEmail({ subject: 'Cancel', body: 'Please cancel my reservation' }), 'review');
});

test('reads the date, time, and party size from a reservation email', () => {
    const body = `Dear Team,

I would like to request a table reservation for 5 people this Saturday, November 28, at 7:00 PM.

Please let me know if you have availability and confirm the booking.

Thank you. Looking forward to hearing from you.

Best regards,
Ravneet`;
    const details = extractBookingDetails(`Reservation Request for 5 People\n${body}`, TODAY);
    assert.equal(details.guests, 5);
    assert.equal(details.time, '19:00');
    assert.equal(details.date, '2026-11-28');
    assert.equal(details.phone, null);
    assert.deepEqual(missingFields(details), ['phone']);
    const letter = composeReply({
        restaurantName: "Billy's Steakhouse",
        guestName: 'Ravneet Punia',
        draft: { ...details, name: 'Ravneet Punia' },
        missing: ['phone'],
        availability: 'open',
        today: TODAY,
    });
    assert.match(letter, /Dear Ravneet,/);
    assert.match(letter, /Saturday, 28 November 2026/);
    assert.match(letter, /7:00 PM/);
    assert.match(letter, /table for 5/);
    assert.match(letter, /phone number we can reach you on/);
    assert.match(letter, /We have availability/);
    assert.doesNotMatch(letter, /the date/);
    assert.match(letter, /Kind regards,\nBilly's Steakhouse/);
});

test('keeps an earlier date and reads a phone number from the follow-up', () => {
    const followUp = `I already told you date in my previous email, my phone number is:
+918930276263

On Mon, 23 Nov, 2026, 8:27 pm , <abhi.roy.kumar101@gmail.com> wrote:

> Could you tell us the date?`;
    const extracted = extractBookingDetails(followUp, TODAY);
    assert.equal(extracted.phone, '+918930276263');
    assert.equal(extracted.date, null);
    const draft = mergeDraft({ date: '2026-11-28', time: '19:00', guests: 5, name: 'Ravneet Punia' }, extracted, 'Ravneet Punia');
    assert.equal(draft.date, '2026-11-28');
    assert.equal(draft.phone, '+918930276263');
    assert.equal(isConfirmation(followUp), false);
});

test('reads a local phone number and ignores a mail tracking clock', () => {
    const body = `I would like to book a table for 2 guests on 2026-11-25. My phone number
is
7061865829.

On Mon, 23 Nov, 2026, 18:13 , <abhi.roy.kumar101@gmail.com> wrote:

> Could you tell us the date?`;
    const earlier = `I want to book a table to your restaurant.

[image: Mailsuite] Sender notified with Mailtrack
23/11/26, 18:11:19`;
    const first = extractBookingDetails(earlier, TODAY);
    const second = extractBookingDetails(body, TODAY);
    const draft = mergeDraft(first, second, 'Abhimanyu Kumar');
    assert.equal(first.time, null);
    assert.equal(draft.guests, 2);
    assert.equal(draft.date, '2026-11-25');
    assert.equal(draft.phone, '7061865829');
    assert.equal(draft.time, null);
    assert.deepEqual(missingFields(draft), ['time']);
    const letter = composeReply({
        restaurantName: "Billy's Steakhouse",
        guestName: 'Abhimanyu Kumar',
        draft,
        missing: ['time'],
        today: TODAY,
    });
    assert.match(letter, /Dear Abhimanyu,/);
    assert.match(letter, /We have your phone number/);
    assert.match(letter, /time you would like to arrive/);
    assert.doesNotMatch(letter, /6:11/);
    assert.doesNotMatch(letter, /phone number we can reach/);
});

test('confirmation letter shows the booking id', () => {
    const letter = composeReply({
        restaurantName: "Billy's Steakhouse",
        guestName: 'Abhimanyu Kumar',
        draft: { date: '2026-11-28', time: '19:00', guests: 5 },
        paymentId: '49e480eb-5941-4536-8c69-41a47725cce1',
        bookingId: 'BK-0A02F85E',
    });
    assert.match(letter, /Booking ID: BK-0A02F85E/);
    assert.doesNotMatch(letter, /Reference/);
    assert.doesNotMatch(letter, /49e480eb/);
});

test('reads 28th Nov and 7PM from a short follow-up', () => {
    const details = extractBookingDetails('I will like to book for 28th Nov, 7PM', TODAY);
    assert.equal(details.date, '2026-11-28');
    assert.equal(details.time, '19:00');
    assert.equal(isConfirmation('Yes, please book'), true);
});
