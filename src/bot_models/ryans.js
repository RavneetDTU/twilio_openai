// src/services/models/ryan.js
import { getRyansPrompt } from '../prompts/ryans_prompt.js';

export const ryanPersona = {
    id: 'ryan',
    name: "Ryan's Steakhouse",
    // Configuration for OpenAI
    model: 'gpt-realtime-mini', // Supports transcription
    voice: 'marin', // female
    temperature: 0.8,
    // The System Prompt (dynamically generated)
    get instructions() {
        return getRyansPrompt();
    },
};