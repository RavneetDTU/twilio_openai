// src/services/whatsapp/whatsappRestaurantPicker.js
// =============================================================================
// WHATSAPP — location → preference → food → recommended list → selected tenant (AI + guided)
// =============================================================================
// Only runs when ctx.directory is present. Tests without a directory keep the
// previous single-restaurant behaviour. Production never falls back to Billy's:
// the guest must pick from the live tenant list.
// =============================================================================

import logger from '../../utils/logger.js';
import {
    coverageText,
    HOST_RESTAURANT_ID,
    isHostRestaurantId,
    pickFromOffered,
    rankRecommendations,
    suggestionText,
} from './whatsappRestaurantDirectory.js';
import {
    chooseFromListText,
    FOOD_PROMPT,
    FOOD_ROWS,
    LOCATION_PROMPT,
    noMatchText,
    noneAvailableText,
    PREFERENCE_PROMPT,
    PREFERENCE_ROWS,
    selectedRestaurantText,
    sendFoodPrompt,
    sendLocationPrompt,
    sendPreferencePrompt,
    STEP,
} from './whatsappSteps.js';
import { applyExtract, extractBookingDetails } from './whatsappExtract.js';
import { todayInTz } from './whatsappDateTime.js';
import { DEFAULT_TIMEZONE } from './whatsappConfig.js';

const BOOK_PHRASES = new Set([
    'book', 'book a table', 'book table', 'booking', 'reservation',
    'table', 'a table', 'dine', 'dinner',
]);

export function hasBookingRestaurant(ctx, session) {
    if (!ctx.directory) return Boolean(ctx.restaurant?.id) && !isHostRestaurantId(ctx.restaurant.id);
    return !isHostRestaurantId(session?.restaurantId);
}

export function isBookIntent(input) {
    if (input?.type === 'reply' && String(input.id) === 'menu:book') return true;
    if (input?.type !== 'text') return false;
    const lower = String(input.text || '').trim().toLowerCase().replace(/[!.,?\s]+$/, '');
    if (BOOK_PHRASES.has(lower)) return true;
    return /\b(book|reservation|table)\b/i.test(lower);
}

function offeredEntries(session) {
    return (session.offeredRestaurants || []).map((row) => (
        typeof row === 'string' ? { id: row, name: row } : row
    ));
}

async function applyRestaurant(ctx, session, entry) {
    if (!ctx.loadRestaurant) {
        logger.error('❌ [WhatsApp] loadRestaurant is missing — cannot select a restaurant');
        return session;
    }
    const restaurant = await ctx.loadRestaurant(entry.id);
    if (!restaurant || isHostRestaurantId(restaurant.id)) {
        await ctx.client.sendText(ctx.waId, chooseFromListText());
        return session;
    }
    ctx.restaurant = restaurant;
    if (session.mode === 'ai') {
        await ctx.client.sendText(ctx.waId, selectedRestaurantText(restaurant.name, session.data || {}));
    }
    logger.info(`🍽️ [WhatsApp] ${ctx.waId} selected restaurant ${restaurant.id} (${restaurant.name})`);
    return {
        ...session,
        restaurantId: restaurant.id,
        awaiting: null,
        step: session.mode === 'ai' ? session.step : STEP.NAME,
        offeredRestaurants: session.offeredRestaurants || [],
    };
}

export async function sendRestaurantSuggestions(ctx, entries) {
    return ctx.client.sendText(ctx.waId, suggestionText(entries));
}

const SKIP_PATTERN = /^(no|none|skip|any|anything|no preference|whatever|surprise me|not sure|n\/?a|doesn't matter|doesnt matter)$/i;

export function isSkipAnswer(value) {
    return SKIP_PATTERN.test(String(value || '').trim());
}

function answerFromInput(input) {
    if (input?.type === 'reply') {
        const id = String(input.id || '');
        if (id.endsWith(':any')) return '';
        const row = [...PREFERENCE_ROWS, ...FOOD_ROWS].find((item) => item.id === id);
        if (row) return row.title;
        return String(input.title || '').trim();
    }
    return String(input?.text || input?.title || '').trim();
}

function snapshotEntries(matches) {
    return matches.map((entry) => ({
        id: entry.id,
        name: entry.name,
        area: entry.area,
        address: entry.address,
        description: entry.description,
        cuisine: entry.cuisine || '',
    }));
}

async function sendRecommendations(ctx, session) {
    const pool = session.locationMatches || [];
    const ranked = rankRecommendations(pool, {
        preference: session.preference,
        food: session.foodInterest,
    });
    if (!ranked.length) {
        await ctx.client.sendText(ctx.waId, noMatchText());
        return { ...session, awaiting: 'location', step: session.mode === 'ai' ? session.step : STEP.LOCATION };
    }
    await sendRestaurantSuggestions(ctx, ranked);
    return {
        ...session,
        awaiting: 'restaurant',
        step: session.mode === 'ai' ? session.step : STEP.RESTAURANT,
        offeredRestaurants: snapshotEntries(ranked),
    };
}

/** Ask for an area, or auto-select when only one restaurant is configured. */
export async function beginRestaurantPick(ctx, session) {
    let entries = [];
    try {
        entries = await ctx.directory.list();
    } catch (error) {
        logger.error(`❌ [WhatsApp] Restaurant list failed: ${error.message}`);
        await ctx.client.sendText(ctx.waId, noneAvailableText());
        return { ...session, awaiting: null, restaurantId: HOST_RESTAURANT_ID };
    }

    if (!entries.length) {
        await ctx.client.sendText(ctx.waId, noneAvailableText());
        return { ...session, awaiting: null, restaurantId: HOST_RESTAURANT_ID, offeredRestaurants: [] };
    }

    if (entries.length === 1) return applyRestaurant(ctx, session, entries[0]);

    await sendLocationPrompt(ctx);
    return {
        ...session,
        restaurantId: HOST_RESTAURANT_ID,
        awaiting: 'location',
        step: session.mode === 'ai' ? session.step : STEP.LOCATION,
        offeredRestaurants: [],
    };
}

function asInput(input) {
    if (input && typeof input === 'object') return input;
    return { type: 'text', text: String(input || '') };
}

function locationTextFrom(input) {
    const value = asInput(input);
    if (value.type === 'reply' && String(value.id || '').startsWith('area:')) {
        return String(value.title || '').trim();
    }
    return String(value.text || value.title || '').trim();
}

async function offerCoverage(ctx, session) {
    let entries = [];
    try {
        entries = await ctx.directory.list();
    } catch (error) {
        logger.error(`❌ [WhatsApp] Coverage list failed: ${error.message}`);
        await ctx.client.sendText(ctx.waId, noneAvailableText());
        return { ...session, awaiting: 'location', restaurantId: HOST_RESTAURANT_ID };
    }
    if (!entries.length) {
        await ctx.client.sendText(ctx.waId, noneAvailableText());
        return { ...session, awaiting: null, restaurantId: HOST_RESTAURANT_ID, offeredRestaurants: [] };
    }
    const prompt = coverageText(entries);
    await ctx.client.sendText(ctx.waId, prompt);
    return {
        ...session,
        restaurantId: HOST_RESTAURANT_ID,
        awaiting: 'location',
        step: session.mode === 'ai' ? session.step : STEP.LOCATION,
        coveragePrompt: prompt,
        offeredRestaurants: snapshotEntries(entries),
        locationMatches: [],
    };
}

export async function handleLocationReply(ctx, session, input) {
    const value = asInput(input);
    const replyId = value.type === 'reply' ? String(value.id || '') : '';

    if (replyId.startsWith('rest:')) {
        const offered = offeredEntries(session).length ? offeredEntries(session) : null;
        if (offered) {
            const picked = pickFromOffered(value, offered);
            if (picked) return applyRestaurant(ctx, session, picked);
        }
        if (ctx.directory?.getById) {
            const entry = await ctx.directory.getById(replyId.slice(5));
            if (entry) return applyRestaurant(ctx, session, entry);
        }
    }

    if (offeredEntries(session).length) {
        const picked = pickFromOffered(value, offeredEntries(session));
        if (picked) return applyRestaurant(ctx, session, picked);
    }

    const locationText = locationTextFrom(value);
    const today = todayInTz(ctx.restaurant?.timezone || DEFAULT_TIMEZONE, ctx.now || new Date());
    session = applyExtract(session, extractBookingDetails(locationText, { today }));
    const query = session.locationQuery || locationText;
    if (!query) return offerCoverage(ctx, session);

    let result;
    try {
        result = await ctx.directory.suggest(query);
    } catch (error) {
        logger.error(`❌ [WhatsApp] Location search failed: ${error.message}`);
        await ctx.client.sendText(ctx.waId, noneAvailableText());
        return { ...session, awaiting: 'location' };
    }

    if (result.unmatched || !result.matches.length) {
        return offerCoverage(ctx, session);
    }

    const next = {
        ...session,
        locationQuery: query,
        locationMatches: snapshotEntries(result.matches),
        offeredRestaurants: [],
        coveragePrompt: null,
    };

    if (next.preference || next.foodInterest) {
        return sendRecommendations(ctx, next);
    }

    await sendPreferencePrompt(ctx);
    return {
        ...next,
        awaiting: 'preference',
        step: session.mode === 'ai' ? session.step : STEP.PREFERENCE,
    };
}

export async function handlePreferenceReply(ctx, session, input) {
    const preference = isSkipAnswer(answerFromInput(input)) ? '' : answerFromInput(input);
    const next = { ...session, preference };
    if (next.foodInterest) return sendRecommendations(ctx, next);
    await sendFoodPrompt(ctx);
    return {
        ...next,
        awaiting: 'food',
        step: session.mode === 'ai' ? session.step : STEP.FOOD,
    };
}

export async function handleFoodReply(ctx, session, input) {
    const foodInterest = isSkipAnswer(answerFromInput(input)) ? '' : answerFromInput(input);
    return sendRecommendations(ctx, { ...session, foodInterest });
}

export async function handleRestaurantReply(ctx, session, input) {
    const offered = offeredEntries(session);
    const picked = pickFromOffered(input, offered);
    if (!picked) {
        await ctx.client.sendText(ctx.waId, chooseFromListText());
        return session;
    }
    return applyRestaurant(ctx, session, picked);
}

export function locationPromptForHistory() {
    return LOCATION_PROMPT;
}

export function preferencePromptForHistory() {
    return PREFERENCE_PROMPT;
}

export function foodPromptForHistory() {
    return FOOD_PROMPT;
}

export function coveragePromptForHistory(session) {
    return session?.coveragePrompt || coverageText(session?.offeredRestaurants || []);
}
