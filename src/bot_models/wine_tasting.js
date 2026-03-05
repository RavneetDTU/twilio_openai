// src/bot_models/wine_tasting.js
import { getWineTastingPrompt } from '../prompts/wine_tasting_prompt.js';

export const wineTastingPersona = {
    id: 'wine_tasting',
    name: "Wine Tasting Terrance",
    // Configuration for OpenAI
    model: 'gpt-realtime-mini', // Supports transcription
    voice: 'marin', // female
    temperature: 0.8,
    // The System Prompt (dynamically generated)
    get instructions() {
        return getWineTastingPrompt();
    },
};
