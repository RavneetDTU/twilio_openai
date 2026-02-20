
// import bjornData from '../prompts/prompts.json' with { type: 'json' };

import { getBjornsPrompt } from '../prompts/bjorns_prompt.js';

export const bjornPersona = {
    id: 'bjorn',
    name: "Bjorn's Steakhouse",
    // Configuration for OpenAI
    model: 'gpt-realtime-mini',
    voice: 'marin', // female
    // speed : '1.15',
    temperature: 0.8,
    // The System Prompt (dynamically generated)
    get instructions() {
        return getBjornsPrompt();
    },
};
