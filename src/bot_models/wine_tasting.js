// src/bot_models/wine_tasting.js
import { getWineTastingPrompt } from '../prompts/wine_tasting_prompt.js';

export const wineTastingPersona = {
    id: 'wine_tasting',
    name: "Wine Tasting Terrance",
    // Configuration for OpenAI
    model: 'gpt-realtime-2', // Supports transcription
    voice: 'marin', // female
    temperature: 0.8,
    // The System Prompt (dynamically generated — async to support real-time capacity lookup)
    async getInstructions() {
        return await getWineTastingPrompt();
    },
};

