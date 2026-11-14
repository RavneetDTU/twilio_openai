import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { splitAudience } from '../../src/services/marketing/audience.js';
import { classifyMarketingIntent, groundedMarketingReply } from '../../src/services/marketing/agent.js';
import {
    applyDeliveryUpdate,
    classifySendError,
    mergeDeliveryStatus,
    progressCampaign,
    recoverStuckRecipients,
} from '../../src/services/marketing/engine.js';
import { applyTemplateUpdate, routeInbound } from '../../src/services/marketing/inbound.js';
import {
    assignContactGroup,
    createCampaign,
    exportContacts,
    getConversation,
    getOverview,
    importCampaignLeads,
    importContacts,
    launchCampaign,
    listContacts,
    listConversations,
    optOutContact,
    saveContact,
    saveTemplate,
    setCampaignControl,
    submitTemplate,
} from '../../src/services/marketing/operations.js';
import { marketingTick } from '../../src/services/marketing/runtime.js';
import { createMemoryMarketingStore } from '../../src/services/marketing/store.js';
import { campaignIsSendable, mapMetaTemplateStatus, validateTemplateDraft } from '../../src/services/marketing/templates.js';
import { isOptOutText, normalizePhone } from '../../src/services/marketing/phone.js';
import { parseIncomingMessage, processWhatsAppWebhook } from '../../src/services/whatsapp/whatsappProcessor.js';
import { createMemorySessionStore } from '../../src/services/whatsapp/whatsappSessionStore.js';

const NOW = new Date('2026-11-11T10:00:00Z');

function limits(extra = {}) {
    return { batchSize: 1000, maxAttempts: 4, intervalMs: 0, nextSlot: 0, noteSend() {}, ...extra };
}

async function approvedTemplate(store, restaurantId = '1') {
    const draft = await saveTemplate(store, restaurantId, {
        name: 'weekend_offer',
        category: 'MARKETING',
        language: 'en',
        body: 'Hi {{1}}, {{2}} has something special this week.',
        examples: ['Asha', "Billy's"],
        footer: 'Reply STOP to opt out',
    });
    await store.put('templates', draft.id, { ...draft, status: 'approved', metaName: draft.name });
    return store.get('templates', draft.id);
}

async function seedContacts(store, count, restaurantId = '1') {
    for (let i = 0; i < count; i += 1) {
        await saveContact(store, restaurantId, {
            name: `Guest ${i}`,
            phone: `+2771000${String(i).padStart(4, '0')}`,
            optIn: true,
            optInSource: 'website_checkbox',
        });
    }
}

describe('phone and consent', () => {
    it('normalizes local South African numbers and rejects junk', () => {
        assert.equal(normalizePhone('082 123 4567').e164, '+27821234567');
        assert.equal(normalizePhone('+1 (415) 555-2671').e164, '+14155552671');
        assert.equal(normalizePhone('12').ok, false);
        assert.equal(isOptOutText('STOP'), true);
        assert.equal(isOptOutText('cancel'), false);
    });

    it('does not treat a contact as eligible without explicit opt-in', async () => {
        const store = createMemoryMarketingStore();
        await saveContact(store, '1', { name: 'No', phone: '+27821111111', optIn: false });
        const contacts = (await listContacts(store, '1')).contacts;
        const split = splitAudience(contacts, [], { type: 'all' });
        assert.equal(split.summary.eligible, 0);
        assert.equal(split.summary.optedOut, 1);
    });
});

describe('csv import', () => {
    it('rejects invalid numbers, missing consent source, suppression, and duplicates', async () => {
        const store = createMemoryMarketingStore();
        await saveContact(store, '1', { name: 'Existing', phone: '+27820000001', optIn: true, optInSource: 'form' });
        await optOutContact(store, '1', '27820000002', 'whatsapp_stop');
        const csv = [
            'name,phone,opt_in,source',
            'Asha,+27820000003,yes,website_checkbox',
            'Bad,123,yes,website_checkbox',
            'Again,+27820000001,yes,website_checkbox',
            'Stopped,0820000002,yes,website_checkbox',
            'No source,+27820000004,yes,',
            'Quiet,+27820000005,no,',
        ].join('\n');
        const preview = await importContacts(store, '1', {
            csv,
            mapping: { name: 'name', phone: 'phone', optIn: 'opt_in', source: 'source' },
            commit: false,
        });
        assert.equal(preview.summary.eligible, 1);
        assert.ok(preview.preview.some((row) => row.reason === 'invalid_phone'));
        assert.ok(preview.preview.some((row) => row.reason === 'duplicate'));
        assert.ok(preview.preview.some((row) => row.reason === 'suppressed'));
        assert.ok(preview.preview.some((row) => row.reason === 'missing_opt_in_source'));
        const committed = await importContacts(store, '1', {
            csv,
            mapping: { name: 'name', phone: 'phone', optIn: 'opt_in', source: 'source' },
            commit: true,
        });
        assert.equal(committed.imported, 2);
        const quiet = (await listContacts(store, '1', { q: '27820000005' })).contacts[0];
        assert.equal(quiet.optIn, false);
        const exported = await exportContacts(store, '1', { optedInOnly: true });
        assert.equal(exported.includes('+27820000005'), false);
        assert.equal(exported.includes('+27820000003'), true);
    });

    it('imports 1000 contacts, pages them, and adds a list without returning every row', async () => {
        const store = createMemoryMarketingStore();
        const lines = ['name,phone,opt_in,source'];
        for (let i = 0; i < 1000; i += 1) lines.push(`Guest ${i},+2772${String(i).padStart(7, '0')},yes,import`);
        lines.push('Bad,12,yes,import');
        const result = await importContacts(store, '1', {
            csv: lines.join('\n'),
            mapping: { name: 'name', phone: 'phone', optIn: 'opt_in', source: 'source' },
            commit: true,
        });
        assert.equal(result.imported, 1000);
        assert.equal(result.summary.rejected, 1);
        const page = await listContacts(store, '1', { limit: 50, offset: 0 });
        assert.equal(page.contacts.length, 50);
        assert.equal(page.total, 1000);
        const grouped = await assignContactGroup(store, '1', { tag: 'Diwali', allMatching: true, q: 'Guest 1' });
        assert.ok(grouped.updated >= 1);
        assert.ok(grouped.updated < 1000);
        const overview = await getOverview(store, '1');
        assert.equal(overview.totalContacts, 1000);
        assert.equal(overview.aiConversations, 0);
    });
});

describe('templates', () => {
    it('validates Meta rules and never marks a template approved just because create succeeded', async () => {
        const bad = validateTemplateDraft({ name: 'Hello', category: 'MARKETING', language: 'en', body: 'Hi {{2}}' });
        assert.equal(bad.ok, false);
        const store = createMemoryMarketingStore();
        const draft = await saveTemplate(store, '1', {
            name: 'weekend_offer',
            category: 'MARKETING',
            language: 'en',
            body: 'Hi {{1}}',
            examples: ['Asha'],
        });
        const pending = await submitTemplate(store, {
            async create() { return { ok: true, id: 'meta-1', status: null }; },
        }, '1', draft.id);
        assert.equal(pending.status, 'pending');
        assert.equal(campaignIsSendable(pending), false);

        await store.put('templates', draft.id, { ...pending, status: 'draft' });
        const rejected = await submitTemplate(store, {
            async create() { return { ok: true, id: 'meta-1', status: 'REJECTED', rejectionReason: 'Promotional language' }; },
        }, '1', draft.id);
        assert.equal(rejected.status, 'rejected');
        assert.equal(rejected.rejectionReason, 'Promotional language');

        await store.put('templates', draft.id, { ...rejected, status: 'draft', rejectionReason: null });
        const approved = await submitTemplate(store, {
            async create() { return { ok: true, id: 'meta-1', status: 'APPROVED' }; },
        }, '1', draft.id);
        assert.equal(approved.status, 'approved');
        assert.equal(mapMetaTemplateStatus('IN_REVIEW'), 'in_review');
    });

    it('applies a template status webhook without inventing approval', async () => {
        const store = createMemoryMarketingStore();
        await store.put('templates', 't1', { id: 't1', restaurantId: '1', name: 'weekend_offer', status: 'pending', metaId: '99' });
        const result = await applyTemplateUpdate(store, { message_template_id: '99', event: 'REJECTED', reason: 'SCAM' });
        assert.equal(result.status, 'rejected');
        assert.equal((await store.get('templates', 't1')).rejectionReason, 'SCAM');
    });
});

describe('campaign execution', () => {
    async function running(count = 20) {
        const store = createMemoryMarketingStore();
        await seedContacts(store, count);
        const template = await approvedTemplate(store);
        const campaign = await createCampaign(store, '1', {
            name: 'Weekend',
            templateId: template.id,
            audience: { type: 'all' },
            variableMapping: [
                { index: 1, source: 'contact.name' },
                { index: 2, source: 'custom', value: "Billy's" },
            ],
        });
        await launchCampaign(store, '1', campaign.id, { confirm: true, restaurantName: "Billy's" });
        return { store, campaignId: campaign.id };
    }

    it('sends a batch once, survives a restart, and does not send twice', async () => {
        const { store, campaignId } = await running(30);
        const sent = [];
        const sender = async ({ to }) => {
            sent.push(to);
            return { ok: true, messageId: `wamid.${sent.length}` };
        };
        let campaign = await progressCampaign({
            store, sender, now: NOW, campaign: await store.get('campaigns', campaignId), limits: limits({ batchSize: 10 }), restaurantName: "Billy's",
        });
        assert.equal(sent.length, 10);
        const chats = await listConversations(store, '1');
        assert.equal(chats.total, 10);
        assert.equal(chats.conversations[0].lastMessageKind, 'template');
        assert.equal(campaign.status, 'running');

        const pending = (await store.list('recipients', [{ field: 'campaignId', op: '==', value: campaignId }])).find((row) => row.status === 'pending');
        await store.put('recipients', pending.id, { ...pending, status: 'sending', wamid: null, claimedAt: new Date(NOW.getTime() - 300000).toISOString() });
        assert.equal(await recoverStuckRecipients(store, NOW), 1);

        campaign = await store.get('campaigns', campaignId);
        while (campaign.status === 'running' || campaign.status === 'queued') {
            campaign = await progressCampaign({ store, sender, now: NOW, campaign, limits: limits(), restaurantName: "Billy's" });
        }
        assert.equal(campaign.status, 'completed');
        assert.equal(sent.length, 30);
        assert.equal(new Set(sent).size, 30);
        const again = sent.length;
        await progressCampaign({ store, sender, now: NOW, campaign: await store.get('campaigns', campaignId), limits: limits(), restaurantName: "Billy's" });
        assert.equal(sent.length, again);
    });

    it('pauses, resumes, cancels, and skips someone who opts out before their turn', async () => {
        const { store, campaignId } = await running(6);
        const sent = [];
        const sender = async ({ to }) => {
            sent.push(to);
            if (sent.length === 2) await setCampaignControl(store, '1', campaignId, 'pause');
            return { ok: true, messageId: `wamid.pause.${sent.length}` };
        };
        await progressCampaign({ store, sender, now: NOW, campaign: await store.get('campaigns', campaignId), limits: limits(), restaurantName: "Billy's" });
        assert.equal(sent.length, 2);
        await progressCampaign({ store, sender, now: NOW, campaign: await store.get('campaigns', campaignId), limits: limits(), restaurantName: "Billy's" });
        assert.equal(sent.length, 2);
        await setCampaignControl(store, '1', campaignId, 'resume');
        const contacts = (await listContacts(store, '1', { limit: 100 })).contacts;
        const notSent = contacts.find((contact) => !sent.includes(contact.phoneE164));
        await optOutContact(store, '1', notSent.phoneDigits, 'whatsapp_stop');
        let campaign = await store.get('campaigns', campaignId);
        while (campaign.status === 'running') {
            campaign = await progressCampaign({ store, sender, now: NOW, campaign, limits: limits(), restaurantName: "Billy's" });
        }
        assert.equal(sent.includes(notSent.phoneE164), false);
        assert.equal(sent.length, 5);

        const second = await running(4);
        let live = await second.store.get('campaigns', second.campaignId);
        const cancelSender = async () => ({ ok: true, messageId: `wamid.cancel.${Math.random()}` });
        await progressCampaign({ store: second.store, sender: cancelSender, now: NOW, campaign: live, limits: limits({ batchSize: 1 }), restaurantName: "Billy's" });
        await setCampaignControl(second.store, '1', second.campaignId, 'cancel');
        const before = (await second.store.list('messages', [])).length;
        await progressCampaign({
            store: second.store,
            sender: cancelSender,
            now: NOW,
            campaign: await second.store.get('campaigns', second.campaignId),
            limits: limits(),
            restaurantName: "Billy's",
        });
        assert.equal((await second.store.list('messages', [])).length, before);
    });

    it('retries temporary failures and stops retrying permanent ones', async () => {
        const { store, campaignId } = await running(1);
        let calls = 0;
        const sender = async () => {
            calls += 1;
            if (calls < 3) return { ok: false, status: 500, error: 'unavailable', code: 1 };
            return { ok: true, messageId: 'wamid.retry' };
        };
        let campaign = await store.get('campaigns', campaignId);
        campaign = await progressCampaign({ store, sender, now: NOW, campaign, limits: limits({ maxAttempts: 4 }), restaurantName: "Billy's" });
        assert.equal(calls, 1);
        assert.equal(campaign.status, 'running');
        const later = new Date(NOW.getTime() + 60 * 60 * 1000);
        const afterBackoff = new Date(later.getTime() + 60 * 60 * 1000);
        campaign = await progressCampaign({ store, sender, now: later, campaign: await store.get('campaigns', campaignId), limits: limits(), restaurantName: "Billy's" });
        campaign = await progressCampaign({ store, sender, now: afterBackoff, campaign, limits: limits(), restaurantName: "Billy's" });
        assert.equal(calls, 3);
        assert.equal(campaign.metrics.sent, 1);
        assert.equal(classifySendError({ ok: false, status: 400, code: 131026, error: 'undeliverable' }), 'permanent');
    });

    it('sends 1000 opted-in contacts once', async () => {
        const { store, campaignId } = await running(1000);
        const sent = new Set();
        const sender = async ({ to }) => {
            if (sent.has(to)) throw new Error(`duplicate ${to}`);
            sent.add(to);
            return { ok: true, messageId: `wamid.${sent.size}` };
        };
        let campaign = await store.get('campaigns', campaignId);
        while (campaign.status === 'queued' || campaign.status === 'running') {
            campaign = await progressCampaign({
                store, sender, now: NOW, campaign, limits: limits({ batchSize: 250 }), restaurantName: "Billy's",
            });
        }
        assert.equal(sent.size, 1000);
        assert.equal(campaign.metrics.sent, 1000);
        assert.equal(campaign.status, 'completed');
    });

    it('holds the batch when the pace window is still closed', async () => {
        const { store, campaignId } = await running(3);
        const sent = [];
        await progressCampaign({
            store,
            sender: async ({ to }) => { sent.push(to); return { ok: true, messageId: `wamid.${sent.length}` }; },
            now: NOW,
            campaign: await store.get('campaigns', campaignId),
            limits: limits({ nextSlot: NOW.getTime() + 10000 }),
            restaurantName: "Billy's",
        });
        assert.equal(sent.length, 0);
    });

    it('refuses to launch without confirmation or an approved marketing template', async () => {
        const store = createMemoryMarketingStore();
        await seedContacts(store, 1);
        const draft = await saveTemplate(store, '1', {
            name: 'weekend_offer', category: 'MARKETING', language: 'en', body: 'Hello', examples: [],
        });
        const campaign = await createCampaign(store, '1', { name: 'Nope', templateId: draft.id, audience: { type: 'all' } });
        await assert.rejects(() => launchCampaign(store, '1', campaign.id, { confirm: true }), /approved marketing template/);
        await store.put('templates', draft.id, { ...(await store.get('templates', draft.id)), status: 'approved' });
        await assert.rejects(() => launchCampaign(store, '1', campaign.id, { confirm: false }), /explicit confirmation/);
    });

    it('imports opted-in leads onto a live campaign without sending a template twice', async () => {
        const { store, campaignId } = await running(1);
        const sender = async () => ({ ok: true, messageId: 'wamid.once' });
        await progressCampaign({ store, sender, now: NOW, campaign: await store.get('campaigns', campaignId), limits: limits(), restaurantName: "Billy's" });
        const csv = 'First name,Last name,Phone number\nAsha,Naidoo,+27820001111\nGuest,0,+27710000000\n';
        const result = await importCampaignLeads(store, '1', campaignId, { csv, confirm: true, optInSource: 'stand form' });
        assert.equal(result.imported, 2);
        assert.equal(result.queued, 1);
        assert.equal(result.skipped, 1);
        const again = await importCampaignLeads(store, '1', campaignId, { csv, confirm: true, optInSource: 'stand form' });
        assert.equal(again.queued, 0);
        await assert.rejects(() => importCampaignLeads(store, '1', campaignId, { csv, confirm: false, optInSource: 'stand form' }), /opted in/);
    });
});

describe('delivery webhooks', () => {
    it('keeps the furthest status when events arrive out of order and ignores duplicates', async () => {
        const store = createMemoryMarketingStore();
        await store.put('messages', 'wamid.1', {
            id: 'wamid.1', restaurantId: '1', campaignId: 'c1', phoneDigits: '27820000001', status: 'sent', direction: 'outbound',
        });
        await store.put('recipients', 'c1_27820000001', {
            id: 'c1_27820000001', campaignId: 'c1', restaurantId: '1', phoneDigits: '27820000001', status: 'sent',
        });
        await store.put('campaigns', 'c1', { id: 'c1', restaurantId: '1', status: 'running' });
        await applyDeliveryUpdate(store, { id: 'wamid.1', status: 'read', timestamp: '2' });
        await applyDeliveryUpdate(store, { id: 'wamid.1', status: 'sent', timestamp: '1' });
        assert.equal((await store.get('messages', 'wamid.1')).status, 'read');
        const duplicate = await applyDeliveryUpdate(store, { id: 'wamid.1', status: 'read', timestamp: '2' });
        assert.equal(duplicate.duplicate, true);
        await applyDeliveryUpdate(store, { id: 'wamid.1', status: 'failed', timestamp: '3' });
        assert.equal((await store.get('messages', 'wamid.1')).status, 'read');
        assert.equal(mergeDeliveryStatus('sent', 'failed'), 'failed');
    });
});

describe('marketing conversation', () => {
    function thread(store) {
        return {
            store,
            deps: { client: { async sendText(to, text) { this.sent = this.sent || []; this.sent.push(text); return { ok: true, messageId: 'wamid.reply' }; }, sent: [] } },
        };
    }

    async function campaignReply(store) {
        await store.put('messages', 'wamid.out', {
            id: 'wamid.out', restaurantId: '1', campaignId: 'camp', conversationId: '1_27821234567', phoneDigits: '27821234567', wamid: 'wamid.out', direction: 'outbound', status: 'delivered',
        });
        await store.put('contacts', '1_27821234567', {
            id: '1_27821234567', restaurantId: '1', phoneDigits: '27821234567', phoneE164: '+27821234567', name: 'Asha', optIn: true,
        });
        await store.put('settings', '1', {
            restaurantId: '1', offers: [{ title: 'Couples table', details: 'Three courses on Friday' }], menuUrl: 'https://example.com/menu',
        });
    }

    it('answers from restaurant facts and does not invent an offer', async () => {
        const store = createMemoryMarketingStore();
        await campaignReply(store);
        const client = { sent: [], async sendText(_to, text) { this.sent.push(text); return { ok: true, messageId: 'ai-1' }; }, async markRead() {} };
        const result = await routeInbound({
            store,
            message: { id: 'in-1', from: '27821234567', context: { id: 'wamid.out' } },
            input: parseIncomingMessage({ type: 'text', text: { body: 'what offers do you have?' } }),
            waId: '27821234567',
            deps: { client },
            loadTenant: async () => ({ restaurantId: '1', name: "Billy's" }),
        });
        assert.equal(result.handled, true);
        assert.match(client.sent[0], /Couples table/);
        assert.equal(/20%|half price/i.test(client.sent[0]), false);
        assert.equal(classifyMarketingIntent('what offers do you have?'), 'offer');
        assert.match(groundedMarketingReply('any discount?', { name: "Billy's", offers: [] }), /don't have a confirmed offer/);
    });

    it('hands booking intent to the booking host and stays quiet for other guests', async () => {
        const store = createMemoryMarketingStore();
        await campaignReply(store);
        let handed = 0;
        const client = { sent: [], async sendText(_to, text) { this.sent.push(text); return { ok: true }; }, async markRead() {} };
        const result = await routeInbound({
            store,
            message: { id: 'in-2', from: '27821234567', context: { id: 'wamid.out' } },
            input: { type: 'text', text: 'Can I book a table?' },
            waId: '27821234567',
            deps: { client },
            handoff: async () => { handed += 1; return { handled: true, session: { mode: 'ai', restaurantId: '1' } }; },
        });
        assert.equal(handed, 1);
        assert.equal(result.session.restaurantId, '1');
        assert.equal(client.sent.length, 0);
        const stranger = await routeInbound({
            store,
            message: { id: 'in-3', from: '27829999999' },
            input: { type: 'text', text: 'hi' },
            waId: '27829999999',
            deps: { client },
        });
        assert.equal(stranger.handled, false);
    });

    it('stops the AI on human takeover and resumes when returned', async () => {
        const store = createMemoryMarketingStore();
        await campaignReply(store);
        await store.put('conversations', '1_27821234567', {
            id: '1_27821234567', restaurantId: '1', phoneDigits: '27821234567', handler: 'human', contactId: '1_27821234567',
        });
        const client = { sent: [], async sendText(_to, text) { this.sent.push(text); return { ok: true }; }, async markRead() {} };
        await routeInbound({
            store,
            message: { id: 'in-4', from: '27821234567' },
            input: { type: 'text', text: 'what offers do you have?' },
            waId: '27821234567',
            deps: { client },
        });
        assert.equal(client.sent.length, 0);
        await store.put('conversations', '1_27821234567', { ...(await store.get('conversations', '1_27821234567')), handler: 'ai' });
        await routeInbound({
            store,
            message: { id: 'in-5', from: '27821234567' },
            input: { type: 'text', text: 'what offers do you have?' },
            waId: '27821234567',
            deps: { client },
            loadTenant: async () => ({ restaurantId: '1', name: "Billy's" }),
        });
        assert.equal(client.sent.length, 1);
    });

    it('does not let the booking host answer a marketing reply', async () => {
        const store = createMemorySessionStore();
        const marketing = createMemoryMarketingStore();
        await marketing.put('messages', 'wamid.out', {
            id: 'wamid.out', wamid: 'wamid.out', restaurantId: '1', campaignId: 'camp', phoneDigits: '27821234567', direction: 'outbound', status: 'sent',
        });
        let bookingCalled = false;
        await processWhatsAppWebhook({
            object: 'whatsapp_business_account',
            entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PHONE' }, messages: [{ id: 'in-9', from: '27821234567', type: 'text', text: { body: 'What is the offer?' }, context: { id: 'wamid.out' } }] } }] }],
        }, {
            store,
            client: { sendText() { bookingCalled = true; }, markRead: async () => {} },
            getConfig: () => ({ phoneId: 'PHONE', conversationMode: 'guided' }),
            marketing: {
                routeInbound: async () => ({ handled: true }),
            },
        });
        assert.equal(bookingCalled, false);
    });
});

describe('tenants', () => {
    it('does not return another restaurant in a scoped list or overview', async () => {
        const store = createMemoryMarketingStore();
        await saveContact(store, '1', { name: 'A', phone: '+27821110001', optIn: true, optInSource: 'form' });
        await saveContact(store, '2', { name: 'B', phone: '+27821110002', optIn: true, optInSource: 'form' });
        const one = await listContacts(store, '1');
        const two = await getOverview(store, '2');
        assert.equal(one.contacts.length, 1);
        assert.equal(one.contacts[0].name, 'A');
        assert.equal(two.totalContacts, 1);
        assert.equal(two.optedInContacts, 1);
    });
});

describe('firestore read budget', () => {
    it('does not list campaigns when nothing is sending', async () => {
        const store = createMemoryMarketingStore();
        for (let i = 0; i < 1000; i += 1) {
            await store.put('campaigns', `c${i}`, { id: `c${i}`, restaurantId: '1', status: i % 2 ? 'completed' : 'draft' });
        }
        let lists = 0;
        const wrapped = {
            ...store,
            list: async (...args) => { lists += 1; return store.list(...args); },
            query: store.query.bind(store),
            count: store.count.bind(store),
        };
        await marketingTick({ store: wrapped, pace: limits(), ticking: false }, NOW);
        assert.equal(lists, 0);
    });

    it('works three active campaigns per wake and leaves the rest queued', async () => {
        const store = createMemoryMarketingStore();
        for (let i = 0; i < 10; i += 1) {
            await store.put('campaigns', `c${i}`, { id: `c${i}`, restaurantId: '1', status: 'running', templateId: 'missing' });
        }
        await marketingTick({ store, pace: limits(), ticking: false, autoWake: false, loadTenant: async () => null }, NOW);
        const campaigns = await store.list('campaigns', []);
        assert.equal(campaigns.filter((item) => item.status === 'failed').length, 3);
        assert.equal(campaigns.filter((item) => item.status === 'running').length, 7);
    });

    it('reads one pending batch and does not scan every recipient', async () => {
        const store = createMemoryMarketingStore();
        await store.put('templates', 't', {
            id: 't', restaurantId: '1', name: 'weekend_offer', status: 'approved', category: 'MARKETING', body: 'Hello {{1}}',
        });
        const contacts = [];
        for (let i = 0; i < 40; i += 1) {
            const phone = `2782000${String(i).padStart(4, '0')}`;
            contacts.push({ id: `1_${phone}`, restaurantId: '1', name: `Guest ${i}`, phoneDigits: phone, phoneE164: `+${phone}`, optIn: true });
            await store.put('contacts', `1_${phone}`, contacts[i]);
        }
        await store.put('campaigns', 'camp', {
            id: 'camp', restaurantId: '1', status: 'running', templateId: 't',
            variableMapping: [{ index: 1, source: 'contact.name' }],
            metrics: { byStatus: { pending: 40, sending: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, cancelled: 0, skipped: 0 }, pending: 40, sending: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, cancelled: 0, skipped: 0, remaining: 40, total: 40 },
        });
        for (let i = 0; i < 40; i += 1) {
            const phone = contacts[i].phoneDigits;
            await store.put('recipients', `camp_${phone}`, {
                id: `camp_${phone}`, campaignId: 'camp', restaurantId: '1', contactId: contacts[i].id,
                phoneDigits: phone, status: 'pending', createdAt: `2026-11-11T10:00:${String(i).padStart(2, '0')}Z`,
            });
        }
        let listed = 0;
        let batchLimit = 0;
        const wrapped = {
            get: store.get.bind(store),
            put: store.put.bind(store),
            delete: store.delete.bind(store),
            updateIf: store.updateIf.bind(store),
            list: async (...args) => { listed += 1; return store.list(...args); },
            query: async (col, options) => {
                if (col === 'recipients') batchLimit = options.limit;
                return store.query(col, options);
            },
            count: store.count.bind(store),
        };
        const sent = [];
        await progressCampaign({
            store: wrapped,
            sender: async ({ to }) => { sent.push(to); return { ok: true, messageId: `wamid.batch.${sent.length}` }; },
            now: NOW,
            campaign: await store.get('campaigns', 'camp'),
            limits: limits({ batchSize: 20 }),
            restaurantName: "Billy's",
        });
        assert.equal(sent.length, 20);
        assert.equal(batchLimit, 20);
        assert.equal(listed, 0);
        const again = [];
        await progressCampaign({
            store: wrapped,
            sender: async ({ to }) => { again.push(to); return { ok: true, messageId: `wamid.next.${again.length}` }; },
            now: NOW,
            campaign: await store.get('campaigns', 'camp'),
            limits: limits({ batchSize: 20 }),
            restaurantName: "Billy's",
        });
        assert.equal(again.length, 20);
        assert.equal(new Set([...sent, ...again]).size, 40);
    });

    it('does not resend when WhatsApp was already called and the result was not saved', async () => {
        const store = createMemoryMarketingStore();
        await store.put('recipients', 'camp_27820000001', {
            id: 'camp_27820000001', campaignId: 'camp', restaurantId: '1', phoneDigits: '27820000001',
            status: 'sending', wamid: null, dispatchStartedAt: new Date(NOW.getTime() - 300000).toISOString(),
            claimedAt: new Date(NOW.getTime() - 300000).toISOString(),
        });
        assert.equal(await recoverStuckRecipients(store, NOW), 0);
        assert.equal((await store.get('recipients', 'camp_27820000001')).status, 'failed');
        assert.equal((await store.get('recipients', 'camp_27820000001')).reason, 'uncertain_delivery');
    });

    it('claims a recipient once when the same batch starts twice', async () => {
        const store = createMemoryMarketingStore();
        await store.put('contacts', '1_27820000009', {
            id: '1_27820000009', restaurantId: '1', name: 'Asha', phoneDigits: '27820000009', phoneE164: '+27820000009', optIn: true,
        });
        await store.put('templates', 't', {
            id: 't', restaurantId: '1', name: 'weekend_offer', status: 'approved', category: 'MARKETING', body: 'Hello {{1}}',
        });
        await store.put('campaigns', 'camp', {
            id: 'camp', restaurantId: '1', status: 'running', templateId: 't',
            variableMapping: [{ index: 1, source: 'contact.name' }],
            metrics: { byStatus: { pending: 1, sending: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, cancelled: 0, skipped: 0 }, pending: 1, sending: 0, sent: 0, remaining: 1, total: 1, delivered: 0, read: 0, replied: 0, failed: 0, cancelled: 0, skipped: 0 },
        });
        await store.put('recipients', 'camp_27820000009', {
            id: 'camp_27820000009', campaignId: 'camp', restaurantId: '1', contactId: '1_27820000009',
            phoneDigits: '27820000009', status: 'pending', createdAt: NOW.toISOString(),
        });
        let sends = 0;
        const sender = async () => { sends += 1; return { ok: true, messageId: `wamid.once.${sends}` }; };
        const campaign = await store.get('campaigns', 'camp');
        await Promise.all([
            progressCampaign({ store, sender, now: NOW, campaign, limits: limits({ batchSize: 20 }), restaurantName: "Billy's" }),
            progressCampaign({ store, sender, now: NOW, campaign, limits: limits({ batchSize: 20 }), restaurantName: "Billy's" }),
        ]);
        assert.equal(sends, 1);
    });

    it('opens a chat with the latest page and a cursor for older messages', async () => {
        const store = createMemoryMarketingStore();
        await store.put('conversations', '1_27820000001', {
            id: '1_27820000001', restaurantId: '1', contactId: '1_27820000001', phoneDigits: '27820000001', name: 'Asha', handler: 'ai', updatedAt: NOW.toISOString(),
        });
        for (let i = 0; i < 40; i += 1) {
            await store.put('messages', `m${i}`, {
                id: `m${i}`, restaurantId: '1', conversationId: '1_27820000001', body: `m${i}`, direction: 'outbound',
                createdAt: `2026-11-11T10:${String(i).padStart(2, '0')}:00Z`,
            });
        }
        const first = await getConversation(store, '1', '1_27820000001', { limit: 30 });
        assert.equal(first.messages.length, 30);
        assert.equal(first.messages[29].id, 'm39');
        assert.ok(first.nextBefore);
        const older = await getConversation(store, '1', '1_27820000001', { limit: 30, before: first.nextBefore });
        assert.equal(older.messages[0].id, 'm0');
        assert.equal(older.nextBefore, null);
        let messageReads = 0;
        const wrapped = {
            ...store,
            list: async (col, ...args) => { if (col === 'messages') messageReads += 1; return store.list(col, ...args); },
        };
        const chats = await listConversations(wrapped, '1');
        assert.equal(chats.total, 1);
        assert.equal(messageReads, 0);
    });
});
