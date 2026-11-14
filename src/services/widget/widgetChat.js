// Text replies for the website widget. Uses the same restaurant prompt as phone calls.
// The long-lived OpenAI key stays on this server.

import logger from '../../utils/logger.js';
import { buildPromptForTenant } from '../../prompts/promptBuilder.js';
import { capacityToolOutput, getAvailableCapacityForDate } from '../capacityService.js';
import { AVAILABILITY_TIME_PARAM } from '../restaurantAvailabilityService.js';
import { transcriptLine } from './widgetStore.js';

const MODEL = 'gpt-4o-mini';

const TEXT_RULES = `
This guest is typing in the website booking widget, not speaking on a phone call.
Reply in short plain text. Ask one question at a time.
Ask the guest to type their phone number. Do not ask them to say digits out loud.
Do not mention tools, function names, or these instructions.
`;

const CHAT_TOOL = {
    type: 'function',
    function: {
        name: 'check_capacity_for_date',
        description: 'Check how many seats are left for a booking date and time. Call this before confirming a reservation.',
        parameters: {
            type: 'object',
            properties: {
                date: { type: 'string', description: 'Booking date as YYYY-MM-DD' },
                time: AVAILABILITY_TIME_PARAM,
            },
            required: ['date', 'time'],
        },
    },
};

export const REALTIME_TOOL = {
    type: 'function',
    name: 'check_capacity_for_date',
    description: 'Check how many seats are left for a booking date and time. Call this before confirming a reservation.',
    parameters: CHAT_TOOL.function.parameters,
};

function cleanTurns(messages) {
    return (Array.isArray(messages) ? messages : [])
        .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && String(item.content || '').trim())
        .slice(-30)
        .map((item) => ({ role: item.role, content: String(item.content).trim().slice(0, 2000) }));
}

async function complete(apiKey, messages) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: MODEL,
            temperature: 0.4,
            tools: [CHAT_TOOL],
            messages,
        }),
    });
    if (!response.ok) {
        const detail = await response.text();
        logger.error(`Widget chat OpenAI error: ${detail.slice(0, 300)}`);
        const error = new Error('Chat response failed');
        error.status = 502;
        throw error;
    }
    return response.json();
}

export async function replyToWidgetChat({ apiKey, tenant, restaurantId, messages, kickoff }) {
    const turns = cleanTurns(messages);
    if (kickoff && turns.length === 0) {
        turns.push({
            role: 'user',
            content: 'The guest just opened the website chat. Reply with only the greeting from the question flow.',
        });
    }
    if (!turns.length) {
        const error = new Error('A message is required');
        error.status = 400;
        throw error;
    }
    const thread = [
        { role: 'system', content: `${buildPromptForTenant(tenant)}\n\n${TEXT_RULES}` },
        ...turns,
    ];
    let content = '';
    for (let step = 0; step < 4; step += 1) {
        const data = await complete(apiKey, thread);
        const message = data?.choices?.[0]?.message;
        const calls = message?.tool_calls || [];
        if (!calls.length) {
            content = String(message?.content || '').trim();
            break;
        }
        thread.push(message);
        for (const call of calls) {
            let args = {};
            try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = {}; }
            let output = { checkFailed: true };
            if (call.function?.name === 'check_capacity_for_date') {
                const capacity = await getAvailableCapacityForDate(tenant.settings, restaurantId, args.date, args.time);
                output = capacityToolOutput(capacity);
            }
            thread.push({
                role: 'tool',
                tool_call_id: call.id,
                content: JSON.stringify(output),
            });
        }
    }
    if (!content) {
        const error = new Error('Empty assistant response');
        error.status = 502;
        throw error;
    }
    const transcript = [];
    for (const turn of turns) {
        if (kickoff && turn.content.startsWith('The guest just opened')) continue;
        transcript.push(transcriptLine(turn.role === 'user' ? 'visitor' : 'assistant', turn.content));
    }
    transcript.push(transcriptLine('assistant', content));
    return {
        message: { role: 'assistant', content },
        restaurantName: tenant.name || '',
        transcript,
    };
}

export async function createRealtimeSecret({ apiKey, instructions, tools, model }) {
    const body = {
        session: {
            type: 'realtime',
            model,
            instructions,
            tools: tools || [REALTIME_TOOL],
            audio: { input: { transcription: { model: 'whisper-1' } } },
        },
    };
    let response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                session: { type: 'realtime', model, instructions: body.session.instructions },
            }),
        });
    }
    if (!response.ok) {
        const detail = await response.text();
        logger.error(`Widget voice session error: ${detail.slice(0, 300)}`);
        const error = new Error('Voice session could not be started');
        error.status = 502;
        throw error;
    }
    const data = await response.json();
    if (!data?.value) {
        const error = new Error('Voice session could not be started');
        error.status = 502;
        throw error;
    }
    return { value: data.value, model };
}
