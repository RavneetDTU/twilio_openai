import OpenAI from 'openai';
import logger from './logger.js';
import dotenv from 'dotenv';
dotenv.config();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

/**
 * Extracts structured booking data from the call transcript using GPT-4.
 * 
 * @param {string} transcriptText - The raw text of the conversation.
 * @returns {Promise<Object|null>} - The structured booking object or null on failure.
 */
export const extractBookingData = async (transcriptText) => {
    if (!transcriptText) {
        logger.warn("⚠️ No transcript provided for extraction.");
        return null;
    }

    // Capture today's real date at the moment of extraction (Africa/Johannesburg timezone)
    const todayDateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' }); // → "YYYY-MM-DD"

    logger.info(`🧠 Extracting booking data from transcript... (Reference date: ${todayDateStr})`);

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                {
                    role: "system",
                    content: `You are a helpful assistant that extracts booking details from a restaurant call transcript.

Today's date (the day the call was made) is: ${todayDateStr}

Use this date as your reference to resolve relative date expressions:
- "tomorrow" → add 1 day to today
- "next Friday" → find the next upcoming Friday from today
- "this Saturday" → the coming Saturday

Identify the final confirmed booking details and return ONLY a raw JSON object with these exact fields:
- name (String) — customer name
- date (String, format YYYY-MM-DD) — the booking date resolved to a real calendar date
- time (String, format HH:mm in 24-hour) — the booking time, e.g. "19:00"
- guests (Number) — number of guests
- phoneNo (String) — customer phone number
- allergy (String or null) — ONLY the allergy name if the customer mentions one (e.g. "peanuts", "gluten", "shellfish"). If no allergy mentioned, set to null.
- notes (String or null) — a short note about the allergy for the kitchen, e.g. "Customer has peanut allergy — please ensure no cross-contamination". If no allergy mentioned, set to null.

Do NOT include any other fields. Do not use markdown formatting. Return ONLY the raw JSON object.`
                },
                {
                    role: "user",
                    content: transcriptText
                }
            ],
            temperature: 0
        });

        const rawContent = completion.choices[0].message.content;

        // Sanitize: sometimes models wrap JSON in ```json ... ```
        const jsonString = rawContent.replace(/```json/g, '').replace(/```/g, '').trim();

        const bookingData = JSON.parse(jsonString);
        logger.info(`✅ Booking Data Extracted: ${JSON.stringify(bookingData, null, 2)}`);

        return bookingData;

    } catch (error) {
        logger.error(`❌ Failed to extract booking data: ${error.message}`);
        return null;
    }
};
