import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    conversationDocId,
    createInboxRecorder,
    createMemoryInboxStore,
    inboxContext,
    mergeDeliveryStatus,
    wrapWhatsAppClient,
} from '../../src/services/whatsapp/whatsappInbox.js';

const PHONE = 'phone-1';

function recorder() {
    const store = createMemoryInboxStore();
    return { store, recorder: createInboxRecorder(store, { phoneNumberId: PHONE }) };
}

describe('whatsapp booking inbox', () => {
    it('keeps one message when the same webhook is delivered twice', async () => {
        const { store, recorder: inbox } = recorder();
        const input = {
            phoneNumberId: PHONE, restaurantId: '1', waId: '27821234567', wamid: 'wamid.1', body: 'Hi', type: 'text', name: 'Asha',
        };
        await inbox.recordInbound(input);
        await inbox.recordInbound(input);
        const id = conversationDocId(PHONE, '1', '27821234567');
        assert.equal((await store.listMessages(id)).length, 1);
        assert.equal((await store.getConversation(id)).unread, 1);
    });

    it('pages conversations and hides another restaurant', async () => {
        const { store, recorder: inbox } = recorder();
        for (let i = 0; i < 40; i += 1) {
            await inbox.recordInbound({
                phoneNumberId: PHONE,
                restaurantId: '1',
                waId: `2782000${String(i).padStart(4, '0')}`,
                wamid: `wamid.page.${i}`,
                body: `Hello ${i}`,
                createdAt: `2026-11-14T10:${String(i).padStart(2, '0')}:00.000Z`,
            });
        }
        await inbox.recordInbound({
            phoneNumberId: PHONE, restaurantId: '2', waId: '27829999999', wamid: 'wamid.other', body: 'Other restaurant',
        });
        const first = await store.queryConversations({ restaurantId: '1', limit: 30 });
        assert.equal(first.conversations.length, 30);
        assert.ok(first.nextCursor);
        const second = await store.queryConversations({ restaurantId: '1', limit: 30, cursor: first.nextCursor });
        assert.equal(second.conversations.length, 10);
        const ids = new Set([...first.conversations, ...second.conversations].map((row) => row.id));
        assert.equal(ids.size, 40);
        assert.equal((await store.queryConversations({ restaurantId: '2', limit: 30 })).conversations.length, 1);
    });

    it('loads the latest messages and leaves the older ones behind the cursor', async () => {
        const { store, recorder: inbox } = recorder();
        for (let i = 0; i < 40; i += 1) {
            await inbox.recordInbound({
                phoneNumberId: PHONE, restaurantId: '1', waId: '27821234567', wamid: `wamid.m.${i}`,
                body: `m${i}`, createdAt: `2026-11-14T10:${String(i).padStart(2, '0')}:00.000Z`,
            });
        }
        const id = conversationDocId(PHONE, '1', '27821234567');
        const latest = (await store.listMessages(id)).slice(0, 30);
        assert.equal(latest.length, 30);
        assert.equal(latest[0].body, 'm39');
        const older = (await store.listMessages(id)).filter((row) => row.createdAt < latest[latest.length - 1].createdAt);
        assert.equal(older.length, 10);
        assert.equal(older.some((row) => row.body === 'm0'), true);
    });

    it('records an outgoing send once and does not downgrade a read receipt', async () => {
        const { store, recorder: inbox } = recorder();
        const client = wrapWhatsAppClient({
            async sendText() {
                return { ok: true, messageId: 'wamid.out' };
            },
        }, () => inbox);
        await inboxContext.run(
            { waId: '27821234567', restaurantId: '1', phoneNumberId: PHONE, profileName: 'Asha' },
            () => client.sendText('27821234567', 'Your booking is confirmed'),
        );
        await inboxContext.run(
            { waId: '27821234567', restaurantId: '1', phoneNumberId: PHONE },
            () => client.sendText('27821234567', 'Your booking is confirmed'),
        );
        const id = conversationDocId(PHONE, '1', '27821234567');
        assert.equal((await store.listMessages(id)).length, 1);
        await inbox.applyStatuses([{ id: 'wamid.out', status: 'read' }]);
        await inbox.applyStatuses([{ id: 'wamid.out', status: 'sent' }]);
        assert.equal(store.messages.get('wamid.out').status, 'read');
        assert.equal(mergeDeliveryStatus('read', 'failed'), 'read');
    });

    it('links more than one booking to the same customer', async () => {
        const { store, recorder: inbox } = recorder();
        await inbox.attachBooking({
            phoneNumberId: PHONE, restaurantId: '1', waId: '27821234567', name: 'Asha',
            booking: { paymentId: 'pay-1', date: '2026-11-15', time: '10:00', guests: 2, status: 'booked' },
        });
        await inbox.attachBooking({
            phoneNumberId: PHONE, restaurantId: '1', waId: '27821234567', name: 'Asha',
            booking: { paymentId: 'pay-2', date: '2026-11-20', time: '19:00', guests: 4, status: 'booked' },
        });
        const row = await store.getConversation(conversationDocId(PHONE, '1', '27821234567'));
        assert.equal(row.hasBooking, true);
        assert.deepEqual(row.bookings.map((item) => item.paymentId), ['pay-2', 'pay-1']);
    });

    it('moves the host chat onto the restaurant once a restaurant is known', async () => {
        const { store, recorder: inbox } = recorder();
        await inbox.recordInbound({
            phoneNumberId: PHONE, restaurantId: 'booki', waId: '27821234567', wamid: 'wamid.host', body: 'Hi, I want to book',
        });
        await inbox.recordOutbound({
            phoneNumberId: PHONE, restaurantId: '1', waId: '27821234567', wamid: 'wamid.reply', body: 'Which date would you prefer?',
        });
        const restaurantId = conversationDocId(PHONE, '1', '27821234567');
        const bodies = (await store.listMessages(restaurantId)).map((row) => row.body).sort();
        assert.deepEqual(bodies, ['Hi, I want to book', 'Which date would you prefer?']);
        assert.equal((await store.getConversation(restaurantId)).promotedFromHost, true);
    });
});
