import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    buildSystemPrompt,
    handleAiMessage,
    inputToText,
    runTool,
    trimHistory,
} from '../../src/services/whatsapp/whatsappAiAgent.js';
import { bodyOf, fakeCtx, NOW, RESTAURANT, text, WA_ID } from './helpers.js';

/** Fake OpenAI client: returns the scripted messages in order and records requests. */
function scriptedAi(script) {
    const requests = [];
    return {
        requests,
        chat: {
            completions: {
                async create(request) {
                    requests.push(structuredClone(request));
                    const next = script.shift();
                    if (next instanceof Error) throw next;
                    if (!next) throw new Error('script exhausted');
                    return { choices: [{ message: next }] };
                },
            },
        },
    };
}

const say = (content) => ({ role: 'assistant', content });
const call = (name, args, id = `call_${name}`) => ({
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

function aiCtx(script, overrides = {}) {
    const base = fakeCtx(overrides);
    base.ai = scriptedAi(script);
    base.ctx.ai = base.ai;
    base.ctx.config = { ...base.ctx.config, aiModel: 'test-model' };
    return base;
}

const started = (extra = {}) => ({
    mode: 'ai',
    restaurantId: '1',
    history: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello! Welcome to Billy\'s Steakhouse.' }],
    ...extra,
});

describe('AI conversation', () => {
    it('first message gets the welcome with "Choose an option", without calling the model', async () => {
        const { ctx, client, ai } = aiCtx([]);
        const session = await handleAiMessage(text('Hi'), null, ctx);

        assert.equal(ai.requests.length, 0);
        assert.equal(client.sent.length, 1);
        const [body, buttonText, rows] = client.last().args;
        assert.equal(client.last().type, 'list');
        assert.match(body, /Hello! Welcome to Billy's Steakhouse/);
        assert.equal(buttonText, 'Choose an option');
        assert.deepEqual(rows.map((r) => r.title), ['🍽️ Book a Table', '📖 View Menu', '📞 Contact Us']);
        assert.equal(session.mode, 'ai');
        assert.equal(session.history.length, 2);
        assert.match(session.history[1].content, /Options shown: 🍽️ Book a Table/);
    });

    it('a tapped option goes to the AI as text and the reply is free text', async () => {
        const { ctx, client, ai } = aiCtx([say('Lovely! How many guests, and which day were you thinking?')]);
        const first = await handleAiMessage(text('Hi'), null, ctx);
        const session = await handleAiMessage({ type: 'reply', id: 'menu:book', title: '🍽️ Book a Table' }, first, ctx);

        assert.equal(client.last().type, 'text');
        assert.match(bodyOf(client.last()), /How many guests/);
        assert.deepEqual(session.history.slice(2), [
            { role: 'user', content: '🍽️ Book a Table' },
            { role: 'assistant', content: 'Lovely! How many guests, and which day were you thinking?' },
        ]);

        const request = ai.requests[0];
        assert.equal(request.model, 'test-model');
        assert.equal(request.messages[0].role, 'system');
        assert.equal(request.messages.at(-1).content, '🍽️ Book a Table');
        assert.deepEqual(request.tools.map((t) => t.function.name), ['get_available_times', 'check_availability', 'create_booking']);
    });

    it('checks availability through the tool before answering', async () => {
        const { ctx, client, ai } = aiCtx([
            call('check_availability', { date: '2026-11-03', time: '19:00', guests: 4 }),
            say('Good news, 7pm on Tuesday works for 4. Shall I book it under Thandi?'),
        ]);
        await handleAiMessage(text('Table for 4 on Tuesday 3 Nov at 7pm?'), started(), ctx);

        const toolMessage = ai.requests[1].messages.find((m) => m.role === 'tool');
        assert.equal(JSON.parse(toolMessage.content).available, true);
        assert.match(bodyOf(client.last()), /7pm on Tuesday works/);
    });

    it('offers alternatives when the time is full', async () => {
        const { ctx, ai } = aiCtx([
            call('check_availability', { date: '2026-11-03', time: '20:00', guests: 4 }),
            say("8pm is full, sorry. I can do 6pm or 7pm, would either work?"),
        ]);
        await handleAiMessage(text('8pm for 4 on the 3rd'), started(), ctx);
        const result = JSON.parse(ai.requests[1].messages.find((m) => m.role === 'tool').content);
        assert.equal(result.available, false);
        assert.equal(result.reason, 'fully booked');
        assert.deepEqual(result.alternatives.map((a) => a.time), ['18:00', '19:00']);
    });

    it('create_booking books through the existing pipeline and code sends the payment link', async () => {
        const { ctx, client, booked, saved, ai } = aiCtx([
            call('create_booking', { name: 'Thandi Mokoena', guests: 4, date: '2026-11-03', time: '19:00', special_requests: 'Birthday' }),
        ]);
        const session = await handleAiMessage(text('Yes please, book it'), started(), ctx);

        assert.equal(ai.requests.length, 1, 'no extra model call after booking');
        assert.equal(booked.length, 1);
        assert.deepEqual(booked[0].data, {
            name: 'Thandi Mokoena', phone: `+${WA_ID}`, guests: 4, date: '2026-11-03', time: '19:00', requests: 'Birthday', sittingId: null,
        });
        assert.match(bodyOf(client.last()), /confirmed/);
        assert.match(bodyOf(client.last()), /https:\/\/payment\.booki\.co\.za\/payment\/abcd1234/);
        assert.equal(saved.length, 1);
        assert.equal(session.lastBooking.date, '2026-11-03');
    });

    it('does not book the same slot twice in one chat', async () => {
        const { ctx, booked } = aiCtx([
            call('create_booking', { name: 'Thandi', guests: 4, date: '2026-11-03', time: '19:00' }),
            say("You're already booked for that, Thandi. See you then!"),
        ]);
        const prior = started({ lastBooking: { date: '2026-11-03', time: '19:00', guests: 4, paymentId: 'x' } });
        await handleAiMessage(text('book it'), prior, ctx);
        assert.equal(booked.length, 0);
    });

    it('a model error sends a polite fallback, not a crash', async () => {
        const { ctx, client } = aiCtx([new Error('rate limited')]);
        const session = await handleAiMessage(text('Are you open on Sunday?'), started(), ctx);
        assert.match(bodyOf(client.last()), /little trouble/);
        assert.deepEqual(session.history, started().history);
    });

    it('"restart" shows the welcome again, "cancel" ends the chat', async () => {
        const { ctx, client, ai } = aiCtx([]);
        const session = await handleAiMessage(text('restart'), started(), ctx);
        assert.equal(ai.requests.length, 0);
        assert.equal(client.last().type, 'list');
        assert.equal(session.history.length, 2);

        const second = aiCtx([]);
        assert.equal(await handleAiMessage(text('cancel'), started(), second.ctx), null);
        assert.match(bodyOf(second.client.last()), /cancelled/);
    });

    it('"Hi" in an ongoing chat starts fresh with the welcome list', async () => {
        for (const greeting of ['Hi', 'hello!', 'Hey ']) {
            const { ctx, client, ai } = aiCtx([]);
            const session = await handleAiMessage(text(greeting), started({ history: [
                { role: 'user', content: 'Table for 5 tomorrow' },
                { role: 'assistant', content: 'What time?' },
            ] }), ctx);
            assert.equal(ai.requests.length, 0);
            assert.equal(client.last().type, 'list');
            assert.equal(client.last().args[1], 'Choose an option');
            assert.equal(session.history.length, 2);
        }
    });

    it('a guided-mode session is not reused in AI mode', async () => {
        const { ctx, client, ai } = aiCtx([]);
        await handleAiMessage(text('Hi'), { step: 'confirm', restaurantId: '1', data: { name: 'X' } }, ctx);
        assert.equal(ai.requests.length, 0);
        assert.equal(client.last().type, 'list');
    });
});

describe('AI tools re-validate input', () => {
    const session = { mode: 'ai', restaurantId: '1', history: [] };

    it('rejects past dates, bad times, too many guests, bad names and phones', async () => {
        const { ctx } = fakeCtx();
        const cases = [
            ['check_availability', { date: '2026-10-01', time: '19:00', guests: 2 }, /already passed/],
            ['check_availability', { date: '2026-11-03', time: 'evening', guests: 2 }, /HH:mm/],
            ['check_availability', { date: '2026-11-03', time: '19:00', guests: 99 }, /larger than 30/],
            ['check_availability', { date: '2026-10-27', time: '10:10', guests: 2 }, /too soon/],
            ['create_booking', { name: '123', guests: 2, date: '2026-11-03', time: '19:00' }, /name/],
            ['create_booking', { name: 'Thandi', guests: 2, date: '2026-11-03', time: '19:00', phone: '12' }, /contact number/],
        ];
        for (const [name, args, pattern] of cases) {
            const { result } = await runTool(name, args, ctx, session);
            assert.match(result.error, pattern, `${name} ${JSON.stringify(args)}`);
        }
    });

    it('get_available_times returns slots or closed', async () => {
        const { ctx } = fakeCtx();
        const open = await runTool('get_available_times', { date: '2026-11-03' }, ctx, session);
        assert.deepEqual(open.result.times.map((t) => t.label), ['6:00 PM', '7:00 PM', '8:00 PM']);
        const closed = await runTool('get_available_times', { date: '2026-10-31' }, ctx, session);
        assert.equal(closed.result.closed, true);
    });

    it('create_booking uses a typed contact number', async () => {
        const { ctx, booked } = fakeCtx();
        await runTool('create_booking', { name: 'Thandi', guests: 2, date: '2026-11-03', time: '7pm', phone: '082 555 1234' }, ctx, session);
        assert.equal(booked[0].data.phone, '+27825551234');
        assert.equal(booked[0].data.time, '19:00');
    });
});

describe('prompt and history helpers', () => {
    it('system prompt has today, the calendar, deposit, menu and contact', () => {
        const prompt = buildSystemPrompt({
            restaurant: RESTAURANT,
            config: { menuUrl: 'https://example.com/menu', contactInfo: '+27 21 000 0000' },
            waId: WA_ID,
            knownName: 'Thandi Mokoena',
            now: NOW,
        });
        assert.match(prompt, /Today is Tuesday, 27 October 2026/);
        assert.match(prompt, /Tue 3 Nov = 2026-11-03/);
        assert.match(prompt, /R100\.00 per guest/);
        assert.match(prompt, /https:\/\/example\.com\/menu/);
        assert.match(prompt, /\+27 21 000 0000/);
        assert.match(prompt, /probably Thandi Mokoena/);
        assert.match(prompt, /Shall I put it under Thandi\?/);
    });

    it('trimHistory starts at a user message', () => {
        const history = [
            { role: 'user', content: '1' },
            { role: 'assistant', tool_calls: [] },
            { role: 'tool', content: '{}' },
            { role: 'assistant', content: 'a' },
            { role: 'user', content: '2' },
            { role: 'assistant', content: 'b' },
        ];
        assert.deepEqual(trimHistory(history, 4), history.slice(4));
    });

    it('button taps and media become text for the model', () => {
        assert.equal(inputToText({ type: 'reply', id: 'x', title: 'Schedule Appointment' }), 'Schedule Appointment');
        assert.match(inputToText({ type: 'unsupported', kind: 'audio' }), /audio/);
    });
});
