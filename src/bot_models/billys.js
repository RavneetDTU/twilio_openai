// src/services/models/billy.js
import { BILLYS_STEAKHOUSE_PROMPT } from '../prompts/billys_prompt.js';

export const billyPersona = {
    id: 'billy',
    name: "Billy's Steakhouse",
    // Configuration for OpenAI
    model: 'gpt-4o-realtime-preview', // Supports transcription
    voice: 'cedar', // male
    temperature: 0.8,
    // The System Prompt
    instructions: BILLYS_STEAKHOUSE_PROMPT,
};
