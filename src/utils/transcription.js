import axios from 'axios';
import logger from './logger.js';
import FormData from 'form-data';
import fs from 'fs';

/**
 * Transcribes an audio file using OpenAI's Whisper API.
 * 
 * @param {string} filePath - Absolute path to the local audio file.
 * @returns {Promise<string>} - The transcribed text.
 */
export const transcribeAudio = async (filePath) => {
    try {
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        logger.info(`🎙️ Transcribing file: ${filePath}`);

        const form = new FormData();
        form.append('file', fs.createReadStream(filePath));
        form.append('model', 'whisper-1');

        const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
            headers: {
                ...form.getHeaders(),
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
            }
        });

        const transcript = response.data.text;
        logger.info(`📝 Transcript: "${transcript}"`);
        return transcript;

    } catch (error) {
        logger.error(`❌ Transcription Failed: ${error.response?.data || error.message}`);
        return null; // Return null so we don't crash the whole flow
    }
};
