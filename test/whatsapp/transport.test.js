// Client limits, signature check, webhook processing (dedupe) and hours parsing.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

import { createAvailabilityProvider, evaluateHoursForTime, windowsFromApi, windowsFromTenant } from '../../src/services/whatsapp/whatsappAvailability.js';
import { clampButtons, clampListRows, createWhatsAppClient } from '../../src/services/whatsapp/whatsappClient.js';
import { parseIncomingMessage, processWhatsAppWebhook } from '../../src/services/whatsapp/whatsappProcessor.js';
import { createMemorySessionStore } from '../../src/services/whatsapp/whatsappSessionStore.js';
import { verifyWhatsAppSignature } from '../../src/services/whatsapp/whatsappSignature.js';
import { fakeCtx, NOW, RESTAURANT, WA_ID } from './helpers.js';

describe('client limits', () => {
    it('max 3 buttons, titles ≤ 20 chars', () => {
        const buttons = clampButtons([
            { id: 'a', title: 'Use Bartholomew Montgomery' },
            { id: 'b', title: 'Two' },
            { id: 'c', title: 'Three' },
            { id: 'd', title: 'Four' },
        ]);
        assert.equal(buttons.length, 3);
        assert.ok(buttons.every((b) => b.type === 'reply' && b.reply.title.length <= 20));
        assert.equal(buttons[0].reply.title, 'Use Bartholomew Mon…');
    });

    it('max 10 rows, titles ≤ 24, descriptions ≤ 72', () => {
        const rows = clampListRows(Array.from({ length: 12 }, (_, i) => ({
            id: `r${i}`, title: 'T'.repeat(30), description: 'D'.repeat(100),
        })));
        assert.equal(rows.length, 10);
        assert.ok(rows.every((r) => r.title.length <= 24 && r.description.length <= 72));
    });
});

describe('client requests', () => {
    const config = () => ({ token: 'tok', phoneId: '123', graphVersion: 'v21.0' });

    it('sendTemplate posts the template with body parameters', async () => {
        const requests = [];
        const client = createWhatsAppClient({
            getConfig: config,
            fetchImpl: async (url, init) => {
                requests.push({ url, init });
                return { ok: true, json: async () => ({ messages: [{ id: 'wamid.1' }] }) };
            },
        });
        const result = await client.sendTemplate(`+${WA_ID}`, 'booking_payment_reminder', ['Thandi', 'Fri 30 Oct']);

        assert.deepEqual(result, { ok: true, messageId: 'wamid.1' });
        assert.equal(requests[0].url, 'https://graph.facebook.com/v21.0/123/messages');
        assert.equal(requests[0].init.headers.Authorization, 'Bearer tok');
        assert.deepEqual(JSON.parse(requests[0].init.body), {
            messaging_product: 'whatsapp',
            to: WA_ID,
            type: 'template',
            template: {
                name: 'booking_payment_reminder',
                language: { code: 'en' },
                components: [{ type: 'body', parameters: [{ type: 'text', text: 'Thandi' }, { type: 'text', text: 'Fri 30 Oct' }] }],
            },
        });
    });

    it('Graph API errors are returned, not thrown', async () => {
        const client = createWhatsAppClient({
            getConfig: config,
            fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Re-engagement message', code: 131047 } }) }),
        });
        const result = await client.sendText(WA_ID, 'hello');
        assert.equal(result.ok, false);
        assert.equal(result.status, 400);
    });

    it('network errors are returned, not thrown', async () => {
        const client = createWhatsAppClient({ getConfig: config, fetchImpl: async () => { throw new Error('ECONNRESET'); } });
        assert.deepEqual(await client.sendText(WA_ID, 'hello'), { ok: false, error: 'ECONNRESET' });
    });

    it('missing credentials do not call the API', async () => {
        let called = false;
        const client = createWhatsAppClient({ getConfig: () => ({}), fetchImpl: async () => { called = true; } });
        const result = await client.sendText(WA_ID, 'hello');
        assert.equal(result.ok, false);
        assert.equal(called, false);
    });
});

describe('X-Hub-Signature-256', () => {
    const secret = 'app-secret';
    const raw = Buffer.from('{"object":"whatsapp_business_account"}');
    const sign = (body, key = secret) => `sha256=${crypto.createHmac('sha256', key).update(body).digest('hex')}`;

    it('accepts a valid signature', () => {
        assert.equal(verifyWhatsAppSignature(raw, sign(raw), secret), true);
    });

    it('rejects a wrong secret, a changed body, a missing prefix and a missing header', () => {
        assert.equal(verifyWhatsAppSignature(raw, sign(raw, 'other'), secret), false);
        assert.equal(verifyWhatsAppSignature(Buffer.from('{"object":"x"}'), sign(raw), secret), false);
        assert.equal(verifyWhatsAppSignature(raw, sign(raw).slice(7), secret), false);
        assert.equal(verifyWhatsAppSignature(raw, undefined, secret), false);
        assert.equal(verifyWhatsAppSignature(raw, 'sha256=short', secret), false);
        assert.equal(verifyWhatsAppSignature(raw, sign(raw), ''), false);
    });
});

describe('webhook processing', () => {
    function payload(messages, phoneNumberId = 'PHONE_ID') {
        return {
            object: 'whatsapp_business_account',
            entry: [{
                changes: [{
                    field: 'messages',
                    value: {
                        metadata: { phone_number_id: phoneNumberId, display_phone_number: '27215550000' },
                        contacts: [{ wa_id: WA_ID, profile: { name: 'Thandi Mokoena' } }],
                        messages,
                    },
                }],
            }],
        };
    }

    function deps() {
        const { ctx, client } = fakeCtx();
        const store = createMemorySessionStore();
        return {
            client,
            store,
            deps: {
                store,
                client,
                availability: ctx.availability,
                booking: ctx.booking,
                contacts: ctx.contacts,
                resolveRestaurant: async () => RESTAURANT,
                getConfig: () => ({ phoneId: 'PHONE_ID', menuUrl: '', contactInfo: '' }),
                now: () => NOW,
            },
        };
    }

    const hi = (id) => ({ id, from: WA_ID, type: 'text', text: { body: 'hi' } });

    it('replies once to a message, and ignores the same message id again', async () => {
        const { deps: d, client, store } = deps();
        await processWhatsAppWebhook(payload([hi('wamid.A')]), d);
        await processWhatsAppWebhook(payload([hi('wamid.A')]), d);
        assert.equal(client.sent.length, 1);
        assert.equal(store.sessions.get(WA_ID).step, 'welcome');
    });

    it('handles messages from one number in order', async () => {
        const { deps: d, store } = deps();
        await processWhatsAppWebhook(payload([
            hi('wamid.1'),
            { id: 'wamid.2', from: WA_ID, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'menu:book', title: 'Book a Table' } } },
        ]), d);
        assert.equal(store.sessions.get(WA_ID).step, 'name');
        assert.equal(store.sessions.get(WA_ID).data.suggestedName, 'Thandi Mokoena');
    });

    it('ignores other phone numbers and non-WhatsApp objects', async () => {
        const { deps: d, client } = deps();
        await processWhatsAppWebhook(payload([hi('wamid.B')], 'OTHER'), d);
        await processWhatsAppWebhook({ object: 'page', entry: [] }, d);
        assert.equal(client.sent.length, 0);
    });

    it('a failing step is logged, not thrown', async () => {
        const { deps: d } = deps();
        d.resolveRestaurant = async () => { throw new Error('Firestore down'); };
        await assert.doesNotReject(processWhatsAppWebhook(payload([hi('wamid.C')]), d));
    });

    it('parseIncomingMessage', () => {
        assert.deepEqual(parseIncomingMessage({ type: 'text', text: { body: 'hi' } }), { type: 'text', text: 'hi' });
        assert.deepEqual(
            parseIncomingMessage({ type: 'interactive', interactive: { list_reply: { id: 'guests:2', title: '2 guests' } } }),
            { type: 'reply', id: 'guests:2', title: '2 guests' }
        );
        assert.deepEqual(parseIncomingMessage({ type: 'image' }), { type: 'unsupported', kind: 'image' });
        assert.equal(parseIncomingMessage({ type: 'reaction' }), null);
    });
});

describe('opening hours for the time list', () => {
    const hours = {
        schedule: {
            Friday: {
                is_closed: false,
                breakfast: { enabled: false },
                lunch: { enabled: true, open_time: '12:00:00', close_time: '15:00:00' },
                dinner: { enabled: true, open_time: '18:00', close_time: '22:00' },
            },
            Monday: { is_closed: true },
        },
    };

    it('uses enabled shifts', () => {
        assert.deepEqual(windowsFromApi([], hours, '2026-10-30'), {
            closed: false,
            windows: [{ open: '12:00', close: '15:00' }, { open: '18:00', close: '22:00' }],
        });
    });

    it('closed day and holiday', () => {
        assert.deepEqual(windowsFromApi([], hours, '2026-11-02'), { closed: true, reason: null });
        assert.deepEqual(
            windowsFromApi([{ date: '2026-10-30', name: 'Staff Party' }], hours, '2026-10-30'),
            { closed: true, reason: 'closed for Staff Party' }
        );
    });

    it('no data for the day → null (fall back)', () => {
        assert.equal(windowsFromApi([], hours, '2026-10-31'), null);
    });

    it('tenant hours fallback', () => {
        assert.deepEqual(
            windowsFromTenant({ Friday: { open: '12:00 PM', close: '11:00 PM' } }, '2026-10-30'),
            { closed: false, windows: [{ open: '12:00', close: '23:00' }] }
        );
        assert.deepEqual(windowsFromTenant({ Friday: { open: 'Closed', close: 'Closed' } }, '2026-10-30'), { closed: true, reason: null });
    });

    it('sheet restaurants use tenant hours and do not call Mybooki', async () => {
        const fetches = [];
        const availability = createAvailabilityProvider({
            fetchImpl: async (url) => {
                fetches.push(url);
                throw new Error(`Mybooki should not be called: ${url}`);
            },
        });
        const restaurant = {
            id: 's_abc123',
            operatingHours: { Friday: { open: '8:00 AM', close: '9:00 PM' } },
        };
        const slots = await availability.getDaySlots(restaurant, '2026-10-30', { today: '2026-10-29', minutesNow: 0 });
        assert.equal(fetches.length, 0);
        assert.equal(slots.closed, false);
        assert.ok(slots.times.length > 0);
        assert.equal(slots.times[0], '08:00');
        assert.equal(slots.times.at(-1), '20:00');
        assert.deepEqual(evaluateHoursForTime(restaurant.operatingHours, '2026-10-30', '19:00'), { ok: true, sittingId: null });
        assert.equal(evaluateHoursForTime(restaurant.operatingHours, '2026-10-30', '22:00').ok, false);
    });
});
