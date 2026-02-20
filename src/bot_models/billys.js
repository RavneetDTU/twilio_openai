// src/services/models/billy.js
import { getBillysPrompt } from '../prompts/billys_prompt.js';

export const billyPersona = {
    id: 'billy',
    name: "Billy's Steakhouse",
    // Configuration for OpenAI
    model: 'gpt-realtime-mini', // Supports transcription
    voice: 'cedar', // male
    temperature: 0.8,
    // The System Prompt (dynamically generated)
    get instructions() {
        return getBillysPrompt();
    },
};
