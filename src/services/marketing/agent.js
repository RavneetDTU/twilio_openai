// Marketing conversation strategy. This is not the booking question flow.
// Booking starts only after the guest asks to book, and that handoff is done
// by the caller — this module never asks for a date, time, or party size.

import { isOptOutText } from './phone.js';

export function classifyMarketingIntent(text) {
    if (isOptOutText(text)) return 'opt_out';
    const value = String(text || '').trim().toLowerCase();
    if (!value) return 'general';
    if (/\b(human|real person|manager|staff member|agent)\b/.test(value)) return 'human';
    if (/\b(book|booking|reserve|reservation|table for|a table)\b/.test(value)) return 'booking';
    if (/\b(offer|offers|discount|deal|promotion|promo|coupon)\b/.test(value)) return 'offer';
    if (/\b(menu|dish|dishes|food|eat)\b/.test(value)) return 'menu';
    if (/\b(hour|hours|open|opening|close|closing|timing|timings)\b/.test(value)) return 'hours';
    if (/\b(where|address|location|directions)\b/.test(value)) return 'location';
    if (/\b(event|events|live music)\b/.test(value)) return 'event';
    return 'general';
}

function listOrUnknown(items, empty) {
    if (!items?.length) return empty;
    return items.map((item) => {
        const title = item.title || item.name;
        const detail = item.details || item.when || '';
        return detail ? `${title}: ${detail}` : title;
    }).join('\n');
}

export function groundedMarketingReply(text, knowledge) {
    const intent = classifyMarketingIntent(text);
    const name = knowledge?.name || 'the restaurant';
    if (intent === 'opt_out') {
        return "You're opted out. We won't send you marketing messages on this number.";
    }
    if (intent === 'human') {
        return `I'll leave this chat with the ${name} team. A person can pick it up from here.`;
    }
    if (intent === 'booking') {
        return '';
    }
    if (intent === 'offer') {
        return listOrUnknown(
            knowledge?.offers,
            `I don't have a confirmed offer at ${name} to share right now.`,
        );
    }
    if (intent === 'menu') {
        if (knowledge?.menuUrl) return `You can look at the menu here: ${knowledge.menuUrl}`;
        return `I don't have a menu link confirmed for ${name}.`;
    }
    if (intent === 'hours') {
        if (knowledge?.hoursText) return knowledge.hoursText;
        return `I don't have confirmed opening hours for ${name}.`;
    }
    if (intent === 'location') {
        const place = [knowledge?.address, knowledge?.city].filter(Boolean).join(', ');
        if (place) return `${name} is at ${place}.`;
        return `I don't have a confirmed address for ${name}.`;
    }
    if (intent === 'event') {
        return listOrUnknown(knowledge?.events, `I don't have a confirmed event at ${name} right now.`);
    }
    return `Happy to help with ${name}. I can tell you about confirmed offers, the menu, hours, or where to find us.`;
}

function systemPrompt(knowledge) {
    return [
        `You write WhatsApp replies for ${knowledge?.name || 'the restaurant'}.`,
        'Sound like a helpful person at the restaurant. Short messages. No bullet walls.',
        'Use only the facts in the JSON below. If a fact is missing, say you do not have it confirmed.',
        'Never invent offers, discounts, prices, menu items, hours, events, or availability.',
        'Do not ask for a booking date, time, or party size. If they want a table, the booking host takes over separately.',
        'Understand informal spelling and Hinglish, and answer in the language the guest used when you can.',
        'Do not repeat the whole offer if it is already in the conversation.',
        `Facts: ${JSON.stringify(knowledge || {})}`,
    ].join('\n');
}

export async function composeMarketingReply({ text, knowledge, history = [], openai, model }) {
    const intent = classifyMarketingIntent(text);
    if (intent === 'booking' || intent === 'opt_out' || intent === 'human') {
        return { intent, text: groundedMarketingReply(text, knowledge) };
    }
    if (!openai) return { intent, text: groundedMarketingReply(text, knowledge) };
    try {
        const completion = await openai.chat.completions.create({
            model: model || 'gpt-4.1-mini',
            temperature: 0.4,
            messages: [
                { role: 'system', content: systemPrompt(knowledge) },
                ...history.slice(-12).map((item) => ({ role: item.role, content: item.content })),
                { role: 'user', content: String(text || '') },
            ],
        });
        const content = completion.choices?.[0]?.message?.content?.trim();
        if (!content) return { intent, text: groundedMarketingReply(text, knowledge) };
        return { intent, text: content };
    } catch {
        return { intent, text: groundedMarketingReply(text, knowledge) };
    }
}

export function knowledgeFromSources({ tenant, settings, config, campaign }) {
    const hours = tenant?.operatingHours;
    let hoursText = '';
    if (hours && typeof hours === 'object') {
        const lines = Object.entries(hours)
            .filter(([, value]) => value && typeof value === 'object')
            .map(([day, value]) => {
                if (value.closed || value.is_closed) return `${day}: closed`;
                if (value.open && value.close) return `${day}: ${value.open}–${value.close}`;
                return '';
            })
            .filter(Boolean);
        hoursText = lines.join('\n');
    }
    return {
        restaurantId: tenant?.restaurantId || settings?.restaurantId || null,
        name: tenant?.name || campaign?.restaurantName || 'the restaurant',
        address: tenant?.directory?.street_address || '',
        city: tenant?.directory?.city || '',
        phone: Array.isArray(tenant?.phoneNumbers) ? String(tenant.phoneNumbers[0] || '') : '',
        cuisine: tenant?.directory?.cuisine || '',
        hoursText,
        menuUrl: settings?.menuUrl || config?.menuUrl || '',
        offers: settings?.offers || [],
        events: settings?.events || [],
        campaignName: campaign?.name || '',
        campaignPurpose: campaign?.description || '',
    };
}
