import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handleAiMessage } from '../../src/services/whatsapp/whatsappAiAgent.js';
import { handleMessage } from '../../src/services/whatsapp/whatsappHandlers.js';
import { processWhatsAppWebhook } from '../../src/services/whatsapp/whatsappProcessor.js';
import {
    cleanArea,
    createRestaurantDirectory,
    HOST_RESTAURANT_ID,
    matchRestaurants,
    pickFromOffered,
    rankRecommendations,
    suggestionText,
    toDirectoryEntry,
} from '../../src/services/whatsapp/whatsappRestaurantDirectory.js';
import { FOOD_PROMPT, LOCATION_PROMPT, PREFERENCE_PROMPT } from '../../src/services/whatsapp/whatsappSteps.js';
import { createMemorySessionStore } from '../../src/services/whatsapp/whatsappSessionStore.js';
import {
    bodyOf,
    DIRECTORY,
    fakeCtx,
    idsOf,
    NOW,
    pickerOverrides,
    reply,
    text,
    WA_ID,
} from './helpers.js';

describe('location matching', () => {
    it('cleans a doubled city name from the dashboard', () => {
        assert.equal(cleanArea('VredenburgVredenburg'), 'Vredenburg');
        assert.equal(cleanArea('Cape Town'), 'Cape Town');
    });

    it('suggests 3 Cape Town restaurants and not Stellenbosch', () => {
        const { matches, unmatched } = matchRestaurants(DIRECTORY, 'Cape Town');
        assert.equal(unmatched, false);
        assert.deepEqual(matches.map((e) => e.id), ['1', '3', '5']);
        assert.equal(matches.length <= 4, true);
        assert.ok(!matches.some((e) => e.id === '2'));
    });

    it('matches a suburb in the street address', () => {
        const { matches } = matchRestaurants(DIRECTORY, 'Woodstock');
        assert.deepEqual(matches.map((e) => e.id), ['5']);
    });

    it('asks again when no restaurant is in that area', () => {
        const { matches, unmatched } = matchRestaurants(DIRECTORY, 'Durban');
        assert.equal(unmatched, true);
        assert.deepEqual(matches, []);
    });

    it('matches a doubled city the guest typed', () => {
        const entries = [{ ...DIRECTORY[0], area: 'Vredenburg' }];
        const { matches, unmatched } = matchRestaurants(entries, 'VredenburgVredenburg');
        assert.equal(unmatched, false);
        assert.equal(matches[0].area, 'Vredenburg');
    });

    it('matches an explicit province without treating Cape Town as Franschhoek', () => {
        const western = matchRestaurants(DIRECTORY, 'Western Cape');
        assert.equal(western.unmatched, false);
        assert.ok(western.matches.some((e) => e.id === '4'));
        const cape = matchRestaurants(DIRECTORY, 'Cape Town');
        assert.ok(!cape.matches.some((e) => e.id === '4'));
        assert.ok(!cape.matches.some((e) => e.id === '2'));
    });

    it('never invents restaurants that are not in the directory', () => {
        const { matches } = matchRestaurants(DIRECTORY, "McDonald's Cape Town");
        assert.ok(matches.every((e) => DIRECTORY.some((d) => d.id === e.id)));
    });
});

describe('picking from the offered list', () => {
    const offered = DIRECTORY.filter((e) => ['1', '3', '5'].includes(e.id));

    it('accepts a number, a name, and a list row', () => {
        assert.equal(pickFromOffered(text('2'), offered).id, '3');
        assert.equal(pickFromOffered(text("Bjorn's Steakhouse"), offered).id, '3');
        assert.equal(pickFromOffered(reply('rest:5'), offered).id, '5');
    });

    it('rejects a name that was not in the list', () => {
        assert.equal(pickFromOffered(text("Ryan's Restaurant"), offered), null);
        assert.equal(pickFromOffered(text('McDonalds'), offered), null);
        assert.equal(pickFromOffered(text('9'), offered), null);
    });
});

describe('ranking by food interest', () => {
    it('puts steakhouses first when the guest wants steak', () => {
        const cape = DIRECTORY.filter((e) => ['1', '3', '5'].includes(e.id));
        const ranked = rankRecommendations(cape, { food: 'steak' });
        assert.deepEqual(ranked.map((e) => e.id), ['1', '3', '5']);
        assert.equal(ranked[0].description, 'Steakhouse');
        assert.equal(ranked[2].id, '5');
    });

    it('puts the wine bar first for wine / date night', () => {
        const ranked = rankRecommendations(DIRECTORY, { preference: 'date night', food: 'wine' });
        assert.equal(ranked[0].id, '2');
    });
});

describe('directory loader', () => {
    it('lists active tenants with their Mybooki addresses', async () => {
        const directory = createRestaurantDirectory({
            listTenants: async () => [
                { restaurantId: '1', isActive: true },
                { restaurantId: '9', isActive: false },
            ],
            getTenantById: async (id) => (id === '1'
                ? { restaurantId: '1', name: "Billy's Steakhouse", venueType: 'steakhouse', isActive: true, phoneNumbers: ['+2711'] }
                : null),
            fetchImpl: async (url) => {
                assert.match(url, /\/restaurants\/1\/address$/);
                return { ok: true, json: async () => ({ street_address: 'V&A Waterfront', city: 'Cape TownCape Town', province_state: 'Western Cape', postal_code: '8001' }) };
            },
        });
        const entries = await directory.list();
        assert.deepEqual(entries, [toDirectoryEntry(
            { restaurantId: '1', name: "Billy's Steakhouse", venueType: 'steakhouse', phoneNumbers: ['+2711'] },
            { street_address: 'V&A Waterfront', city: 'Cape TownCape Town', province_state: 'Western Cape', postal_code: '8001' }
        )]);
        assert.equal(entries[0].area, 'Cape Town');
        assert.equal(entries[0].description, 'Steakhouse');
    });

    it('uses stored directory for sheet restaurants and does not call Mybooki', async () => {
        const fetches = [];
        const directory = createRestaurantDirectory({
            listTenants: async () => [{ restaurantId: 's_abc123', isActive: true }],
            getTenantById: async () => ({
                restaurantId: 's_abc123',
                name: 'Banchan',
                venueType: 'restaurant',
                isActive: true,
                phoneNumbers: ['+27111234567'],
                directory: { city: 'Sandton', street_address: 'Sandton City', province: 'Gauteng' },
            }),
            fetchImpl: async (url) => {
                fetches.push(url);
                throw new Error(`Mybooki should not be called: ${url}`);
            },
        });
        const entries = await directory.list();
        assert.equal(fetches.length, 0);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].id, 's_abc123');
        assert.equal(entries[0].name, 'Banchan');
        assert.equal(entries[0].area, 'Sandton');
        assert.equal(entries[0].address, 'Sandton City');
    });
});

describe('AI location → restaurant → booking restaurant id', () => {
    async function openBooking(ctx) {
        const welcome = await handleAiMessage(text('Hi'), null, ctx);
        return handleAiMessage({ type: 'reply', id: 'menu:book', title: '🍽️ Book a Table' }, welcome, ctx);
    }

    async function afterIntake(ctx, session, location, preference = 'No preference', food = 'No preference') {
        session = await handleAiMessage(text(location), session, ctx);
        session = await handleAiMessage(text(preference), session, ctx);
        session = await handleAiMessage(text(food), session, ctx);
        return session;
    }

    it('asks location, preference and food as text, then a numbered restaurant list', async () => {
        const { ctx, client } = fakeCtx(pickerOverrides());
        const afterBook = await openBooking(ctx);
        assert.equal(client.last().type, 'text');
        assert.match(bodyOf(client.last()), /area/i);
        assert.equal(afterBook.awaiting, 'location');
        assert.equal(afterBook.restaurantId, HOST_RESTAURANT_ID);

        const afterArea = await handleAiMessage(text('Cape Town'), afterBook, ctx);
        assert.equal(afterArea.awaiting, 'preference');
        assert.equal(client.last().type, 'text');
        assert.match(bodyOf(client.last()), /romantic, relaxed, lively/);

        const afterPref = await handleAiMessage(text('No preference'), afterArea, ctx);
        assert.equal(afterPref.awaiting, 'food');
        assert.equal(client.last().type, 'text');
        assert.match(bodyOf(client.last()), /cuisine in mind/);

        const afterFood = await handleAiMessage(text('No preference'), afterPref, ctx);
        assert.equal(afterFood.awaiting, 'restaurant');
        assert.equal(client.last().type, 'text');
        assert.match(bodyOf(client.last()), /Billy's Steakhouse/);
        assert.match(bodyOf(client.last()), /Bjorn's Steakhouse/);
        assert.match(bodyOf(client.last()), /The Test Kitchen/);
        assert.doesNotMatch(bodyOf(client.last()), /Ryan's Restaurant/);
        assert.deepEqual(afterFood.offeredRestaurants.map((e) => e.id), ['1', '3', '5']);
        assert.match(suggestionText(afterFood.offeredRestaurants), /which one catches your eye/i);
        assert.equal(PREFERENCE_PROMPT.length > 0, true);
        assert.equal(FOOD_PROMPT.length > 0, true);
    });

    it('reorders Cape Town matches by food interest without a popup list', async () => {
        const { ctx, client } = fakeCtx(pickerOverrides());
        let session = await openBooking(ctx);
        session = await handleAiMessage(text('Cape Town'), session, ctx);
        session = await handleAiMessage({ type: 'reply', id: 'pref:date', title: 'Date night' }, session, ctx);
        session = await handleAiMessage({ type: 'reply', id: 'food:steak', title: 'Steak' }, session, ctx);
        assert.equal(session.awaiting, 'restaurant');
        assert.equal(session.preference, 'Date night');
        assert.equal(session.foodInterest, 'Steak');
        assert.equal(client.last().type, 'text');
        assert.match(bodyOf(client.last()), /might suit what you're looking for/);
        assert.equal(session.offeredRestaurants[0].description, 'Steakhouse');
    });

    it('selecting the second restaurant books that restaurant, not Billy\'s', async () => {
        const { ctx, client, booked } = fakeCtx(pickerOverrides());
        ctx.ai = {
            chat: { completions: { create: async () => ({ choices: [{ message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'create_booking', arguments: JSON.stringify({ name: 'Thandi', guests: 2, date: '2026-11-03', time: '19:00' }) } }],
            } }] }) } },
        };
        let session = await openBooking(ctx);
        session = await afterIntake(ctx, session, 'Cape Town');
        session = await handleAiMessage(text('I like option 2'), session, ctx);
        assert.equal(session.restaurantId, '3');
        assert.equal(ctx.restaurant.id, '3');
        assert.match(bodyOf(client.last()), /Bjorn's Steakhouse/);
        assert.doesNotMatch(bodyOf(client.last()), /Billy's/);

        session = await handleAiMessage(text('Yes, book it'), session, ctx);
        assert.equal(booked.length, 1);
        assert.equal(booked[0].restaurant.id, '3');
        assert.notEqual(booked[0].restaurant.id, '1');
        assert.equal(booked[0].restaurant.name, "Bjorn's Steakhouse");
    });

    it('selects by name as well as by list row', async () => {
        const { ctx } = fakeCtx(pickerOverrides());
        let session = await openBooking(ctx);
        session = await afterIntake(ctx, session, 'Cape Town');
        session = await handleAiMessage({ type: 'reply', id: 'rest:5', title: 'The Test Kitchen' }, session, ctx);
        assert.equal(session.restaurantId, '5');
        assert.equal(ctx.restaurant.id, '5');
    });

    it('rejects a restaurant that was not suggested', async () => {
        const { ctx, client } = fakeCtx(pickerOverrides());
        let session = await openBooking(ctx);
        session = await afterIntake(ctx, session, 'Cape Town');
        session = await handleAiMessage(text("Ryan's Restaurant"), session, ctx);
        assert.equal(session.restaurantId, HOST_RESTAURANT_ID);
        assert.equal(session.awaiting, 'restaurant');
        assert.match(bodyOf(client.last()), /listed/);
    });

    it('asks for a nearby area when nothing matches', async () => {
        const { ctx, client } = fakeCtx(pickerOverrides());
        let session = await openBooking(ctx);
        session = await handleAiMessage(text('Durban'), session, ctx);
        assert.equal(session.awaiting, 'location');
        assert.equal(client.last().type, 'text');
        assert.match(bodyOf(client.last()), /Cape Town/);
        assert.doesNotMatch(bodyOf(client.last()), /Choose an option/);
    });

    it('lets the guest pick a restaurant from the coverage list', async () => {
        const { ctx } = fakeCtx(pickerOverrides());
        let session = await openBooking(ctx);
        session = await handleAiMessage(text('Durban'), session, ctx);
        session = await handleAiMessage({ type: 'reply', id: 'rest:2', title: "Ryan's Restaurant" }, session, ctx);
        assert.equal(session.restaurantId, '2');
        assert.equal(ctx.restaurant.id, '2');
    });
});

describe('guided mode with a directory', () => {
    it('asks location before the name, then uses the chosen restaurant', async () => {
        const { ctx, client } = fakeCtx(pickerOverrides());
        let session = await handleMessage(text('hi'), null, ctx);
        session = await handleMessage(reply('menu:book'), session, ctx);
        assert.equal(session.step, 'location');
        assert.equal(bodyOf(client.last()), LOCATION_PROMPT);

        session = await handleMessage(text('Stellenbosch'), session, ctx);
        assert.equal(session.step, 'preference');
        session = await handleMessage(text('No preference'), session, ctx);
        assert.equal(session.step, 'food');
        session = await handleMessage(text('No preference'), session, ctx);
        assert.equal(session.step, 'restaurant');
        assert.equal(session.offeredRestaurants[0].id, '2');
        assert.equal(client.last().type, 'text');
        assert.match(bodyOf(client.last()), /Ryan's Restaurant/);

        session = await handleMessage(text('1'), session, ctx);
        assert.equal(session.step, 'name');
        assert.equal(session.restaurantId, '2');
        assert.equal(ctx.restaurant.id, '2');
    });
});

describe('two guests at once', () => {
    function payload(from, id, body) {
        return {
            object: 'whatsapp_business_account',
            entry: [{ changes: [{ field: 'messages', value: {
                metadata: { phone_number_id: 'PHONE_ID', display_phone_number: '27215550000' },
                contacts: [{ wa_id: from, profile: { name: 'Guest' } }],
                messages: [{ id, from, type: 'text', text: { body } }],
            } }] }],
        };
    }

    it('keeps each guest on their own restaurant', async () => {
        const a = fakeCtx(pickerOverrides());
        const b = fakeCtx(pickerOverrides());
        const store = createMemorySessionStore();
        const depsFor = (fake, from) => ({
            store,
            client: fake.client,
            availability: fake.ctx.availability,
            booking: fake.ctx.booking,
            contacts: fake.ctx.contacts,
            directory: fake.ctx.directory,
            loadRestaurant: fake.ctx.loadRestaurant,
            hostRestaurant: fake.ctx.hostRestaurant,
            getConfig: () => ({ phoneId: 'PHONE_ID', conversationMode: 'guided' }),
            now: () => NOW,
        });

        const waA = '27820000001';
        const waB = '27820000002';
        await processWhatsAppWebhook(payload(waA, 'a1', 'hi'), depsFor(a, waA));
        await processWhatsAppWebhook(payload(waB, 'b1', 'hi'), depsFor(b, waB));

        a.ctx.waId = waA;
        b.ctx.waId = waB;
        let sessionA = store.sessions.get(waA);
        let sessionB = store.sessions.get(waB);
        sessionA = await handleMessage({ type: 'reply', id: 'menu:book', title: 'Book' }, sessionA, a.ctx);
        sessionB = await handleMessage({ type: 'reply', id: 'menu:book', title: 'Book' }, sessionB, b.ctx);
        sessionA = await handleMessage(text('Cape Town'), sessionA, a.ctx);
        sessionB = await handleMessage(text('Stellenbosch'), sessionB, b.ctx);
        sessionA = await handleMessage(text('No preference'), sessionA, a.ctx);
        sessionB = await handleMessage(text('No preference'), sessionB, b.ctx);
        sessionA = await handleMessage(text('No preference'), sessionA, a.ctx);
        sessionB = await handleMessage(text('No preference'), sessionB, b.ctx);
        sessionA = await handleMessage(text('2'), sessionA, a.ctx);
        sessionB = await handleMessage(text('1'), sessionB, b.ctx);

        await store.save(waA, sessionA);
        await store.save(waB, sessionB);

        assert.equal(store.sessions.get(waA).restaurantId, '3');
        assert.equal(store.sessions.get(waB).restaurantId, '2');
        assert.equal(a.ctx.restaurant.id, '3');
        assert.equal(b.ctx.restaurant.id, '2');
        assert.notEqual(store.sessions.get(waA).restaurantId, '1');
    });
});
