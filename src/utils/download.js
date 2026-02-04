import axios from 'axios';
import fs from 'fs';
import path from 'path';

/**
 * Downloads a file from a URL using a stream and saves it to a local path.
 * Authenticats with Twilio using env vars if provided.
 * 
 * @param {string} url - The URL to download (e.g., Twilio Recording URL).
 * @param {string} outputPath - The local file path to save to.
 * @returns {Promise<string>} - Resolves with the outputPath on success.
 */
export const downloadFile = async (url, outputPath) => {
    const writer = fs.createWriteStream(outputPath);

    // Append extension if missing (Twilio URLs often lack .mp3)
    let downloadUrl = url;
    if (!downloadUrl.endsWith('.mp3') && !downloadUrl.endsWith('.wav')) {
        downloadUrl += '.mp3';
    }

    console.log(`⬇️ Downloading: ${downloadUrl} -> ${outputPath}`);

    const response = await axios({
        url: downloadUrl,
        method: 'GET',
        responseType: 'stream',
        auth: {
            username: process.env.TWILIO_ACCOUNT_SID,
            password: process.env.TWILIO_AUTH_TOKEN
        }
    });

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', () => {
            console.log(`✅ Download complete: ${outputPath}`);
            resolve(outputPath);
        });
        writer.on('error', reject);
    });
};
