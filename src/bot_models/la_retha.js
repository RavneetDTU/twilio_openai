// src/bot_models/la_retha.js
import { getLaRethaPrompt } from '../prompts/la_retha_prompt.js';

export const laRethaPersona = {
    id: 'la_retha',
    name: "La Retha",
    // Configuration for OpenAI
    model: 'gpt-realtime-2', // Supports transcription
    voice: 'marin', // female
    temperature: 0.8,
    // The System Prompt (dynamically generated — called fresh on every call)
    get instructions() {
        return getLaRethaPrompt();
    },
};
