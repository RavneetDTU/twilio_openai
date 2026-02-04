import { RYANS_STEAKHOUSE_PROMPT } from '../prompts/ryans_prompt.js';

export const ryanPersona = {
    id: 'billy',
    name: "Billy's Steakhouse",
    // Configuration for OpenAI
    model: 'gpt-4o-realtime-preview', // Supports transcription
    voice: 'marin', // alloy-female
    temperature: 0.8,
    // The System Prompt
    instructions: RYANS_STEAKHOUSE_PROMPT,
};