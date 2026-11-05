import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyExtract, extractBookingDetails, isGreetingOnly } from '../../src/services/whatsapp/whatsappExtract.js';
import { handleAiMessage } from '../../src/services/whatsapp/whatsappAiAgent.js';
import { pickFromOffered } from '../../src/services/whatsapp/whatsappRestaurantDirectory.js';
import { bodyOf, fakeCtx, pickerOverrides, text } from './helpers.js';

describe('extractBookingDetails', () => {
    const today = '2026-11-04';

    it('reads guests, date and time from one sentence', () => {
        const extracted = extractBookingDetails('Hi, I want to book a table for 5 people tomorrow at 3 PM.', { today });
        assert.equal(extracted.guests, 5);
        assert.equal(extracted.date, '2026-11-05');
        assert.equal(extracted.time, '15:00');
        assert.equal(isGreetingOnly('Hi, I want to book a table for 5 people tomorrow at 3 PM.'), false);
    });

    it('reads a location without inventing a restaurant', () => {
        const extracted = extractBookingDetails('I want to find a restaurant in Durban', { today });
        assert.equal(extracted.location, 'Durban');
        assert.equal(extracted.guests, null);
    });

    it('treats "actually make it 6 guests" as a correction', () => {
        const extracted = extractBookingDetails('Actually, make it 6 guests.', { today });
        assert.equal(extracted.guests, 6);
        assert.equal(extracted.correction, true);
        const session = applyExtract({ data: { guests: 5, date: '2026-11-05' } }, extracted);
        assert.equal(session.data.guests, 6);
        assert.equal(session.data.date, '2026-11-05');
        assert.equal(session.lastCorrection, 'guests');
    });
});

describe('natural WhatsApp booking turns', () => {
    it('keeps a compound first message and only asks for the area', async () => {
        const { ctx, client } = (() => {
            const base = fakeCtx(pickerOverrides());
            base.ctx.ai = { chat: { completions: { create: async () => { throw new Error('model should not run'); } } } };
            return { ctx: base.ctx, client: base.client };
        })();
        const session = await handleAiMessage(text('Hi, I want to book a table for 5 people tomorrow at 3 PM'), null, ctx);
        assert.equal(session.awaiting, 'location');
        assert.equal(session.data.guests, 5);
        assert.equal(session.data.date, '2026-10-28');
        assert.equal(session.data.time, '15:00');
        assert.equal(client.sent.length, 1);
        assert.equal(client.last().type, 'text');
        assert.match(bodyOf(client.last()), /area/i);
        assert.doesNotMatch(bodyOf(client.last()), /Choose an option/);
    });

    it('selects option 2 from a numbered text list', () => {
        const offered = [
            { id: '1', name: "Billy's Steakhouse" },
            { id: '3', name: "Bjorn's Steakhouse" },
        ];
        assert.equal(pickFromOffered(text('I like option 2'), offered).id, '3');
        assert.equal(pickFromOffered(text('2'), offered).id, '3');
    });
});
