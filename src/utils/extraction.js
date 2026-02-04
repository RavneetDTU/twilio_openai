import OpenAI from 'openai';
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
        console.warn("⚠️ No transcript provided for extraction.");
        return null;
    }

    console.log("🧠 Extracting booking data from transcript...");

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                {
                    role: "system",
                    content: `You are a helpful assistant that extracts booking details from a restaurant call transcript.
                    
                    Identify the final confirmed details for:
                    - name (String)
                    - bookingTime (String, format "YYYY-MM-DD HH:mm" or clear text like "Tomorrow 7:00 PM")
                    - guests (Number)
                    - phoneNo (String)
                    - allergy (String, or null if none)

                    Return ONLY a raw JSON object. Do not use markdown formatting.`
                },
                {
                    role: "user",
                    content: transcriptText
                }
            ],
            temperature: 0
        });

        const rawContent = completion.choices[0].message.content;

        // Sanitize: sometimes models wrap JSON in \`\`\`json ... \`\`\`
        const jsonString = rawContent.replace(/```json/g, '').replace(/```/g, '').trim();

        const bookingData = JSON.parse(jsonString);
        console.log("✅ Booking Data Extracted:", JSON.stringify(bookingData, null, 2));

        return bookingData;

    } catch (error) {
        console.error("❌ Failed to extract booking data:", error);
        return null;
    }
};
