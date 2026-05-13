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

IMPORTANT: The call may have been cut short or incomplete. Extract whatever details are available from the transcript, even if the conversation ended abruptly. For any details NOT mentioned or discussed in the transcript, set the value to null.

Return ONLY a raw JSON object with these exact fields:
- name (String or null) — customer name, if mentioned at any point in the call
- date (String or null, format YYYY-MM-DD) — the booking date resolved to a real calendar date
- time (String or null, format hh:mm A in 12-hour) — the booking time, e.g. "07:00 PM"
- guests (Number or null) — number of guests
- phoneNo (String or null) — customer phone number
- allergy (String or null) — ONLY the allergy name if the customer mentions one (e.g. "peanuts", "gluten", "shellfish"). If no allergy mentioned, set to null.
- notes (String or null) — a short note about the allergy for the kitchen, e.g. "Customer has peanut allergy — please ensure no cross-contamination". If no allergy mentioned, set to null.

Do NOT include any other fields. Do not use markdown formatting. Return ONLY the raw JSON object. Always return valid JSON even if most fields are null.`
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

/**
 * Detects whether the call was a reservation attempt or a manager message.
 *
 * @param {string} transcriptText - The raw transcript of the conversation.
 * @returns {Promise<'reservation'|'manager_message'|'unknown'>}
 */
export const extractCallIntent = async (transcriptText) => {
    if (!transcriptText) {
        logger.warn('⚠️ No transcript provided for intent classification.');
        return 'unknown';
    }

    logger.info('🧠 Classifying call intent from transcript...');

    try {
        const completion = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                {
                    role: 'system',
                    content: `You are a call classifier for a restaurant AI assistant.
Your job is to read a call transcript and determine the caller's primary intent.

Return ONLY one of the following three values — nothing else, no explanation:
- "reservation"       → The caller was trying to book a table (even if incomplete or failed)
- "manager_message"   → The caller wanted to leave a message for the manager, provide feedback, make a complaint, or pass on information
- "unknown"           → The intent could not be clearly determined

Rules:
- If the caller mentioned booking, table, reservation, date, time, guests, or deposit → "reservation"
- If the caller mentioned manager, message, feedback, complaint, suggestion, or wanted to pass something on → "manager_message"
- If the call was very short, silent, or completely unrelated → "unknown"
- Return ONLY the raw string value. No JSON, no quotes, no punctuation.`
                },
                {
                    role: 'user',
                    content: transcriptText
                }
            ],
            temperature: 0
        });

        const intent = completion.choices[0].message.content.trim().toLowerCase();

        if (['reservation', 'manager_message', 'unknown'].includes(intent)) {
            logger.info(`✅ Call intent classified as: "${intent}"`);
            return intent;
        }

        logger.warn(`⚠️ Unexpected intent value from GPT: "${intent}" — defaulting to "unknown"`);
        return 'unknown';

    } catch (error) {
        logger.error(`❌ Failed to classify call intent: ${error.message}`);
        return 'unknown';
    }
};

/**
 * Extracts structured manager message data from a transcript.
 *
 * @param {string} transcriptText - The raw transcript of the conversation.
 * @returns {Promise<{name: string|null, phoneNo: string|null, message: string|null}|null>}
 */
export const extractManagerMessageData = async (transcriptText) => {
    if (!transcriptText) {
        logger.warn('⚠️ No transcript provided for manager message extraction.');
        return null;
    }

    logger.info('🧠 Extracting manager message data from transcript...');

    try {
        const completion = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                {
                    role: 'system',
                    content: `You are a data extractor for a restaurant AI assistant.
Read the call transcript and extract the details from a caller who wanted to leave a message for the manager.

Return ONLY a raw JSON object with exactly these fields:
- name (String or null)     — the caller's name, if mentioned
- phoneNo (String or null)  — the caller's phone number exactly as spoken (digits only, no formatting)
- message (String or null)  — the verbatim message the caller wanted to pass to the manager. Capture the full content, do NOT summarise.

Rules:
- Do NOT infer or guess any field that wasn't clearly stated.
- Do NOT include booking details (date, time, guests, allergies) — this is not a reservation.
- Return ONLY valid raw JSON. No markdown, no code fences, no explanation.`
                },
                {
                    role: 'user',
                    content: transcriptText
                }
            ],
            temperature: 0
        });

        const rawContent = completion.choices[0].message.content;
        const jsonString = rawContent.replace(/```json/g, '').replace(/```/g, '').trim();
        const messageData = JSON.parse(jsonString);

        logger.info(`✅ Manager Message Data Extracted: ${JSON.stringify(messageData, null, 2)}`);
        return messageData;

    } catch (error) {
        logger.error(`❌ Failed to extract manager message data: ${error.message}`);
        return null;
    }
};
