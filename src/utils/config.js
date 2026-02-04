import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.resolve(__dirname, '../prompts/prompts.json');

/**
 * Updates the prompt configuration file.
 * @param {Object} updates - The partial updates containing restaurantId and settings/hours.
 * @returns {Promise<Object>} - The updated configuration object.
 */
export const updateConfig = async (updates) => {
    try {
        console.log("📝 Updating config with:", JSON.stringify(updates, null, 2));

        // 1. Read File
        const fileData = await fs.readFile(CONFIG_PATH, 'utf-8');
        const currentConfig = JSON.parse(fileData);

        // 2. Validation
        if (!updates.restaurantId) {
            throw new Error("Missing required field: restaurantId");
        }
        if (updates.restaurantId !== currentConfig.restaurantId) {
            throw new Error(`Invalid restaurantId. Expected: ${currentConfig.restaurantId}, Received: ${updates.restaurantId}`);
        }

        // 3. Smart Merge
        // Merge settings if provided
        if (updates.settings) {
            currentConfig.settings = {
                ...currentConfig.settings,
                ...updates.settings
            };
        }

        // Merge operatingHours if provided
        if (updates.operatingHours) {
            currentConfig.operatingHours = {
                ...currentConfig.operatingHours,
                ...updates.operatingHours
            };
        }

        // 4. Write File
        await fs.writeFile(CONFIG_PATH, JSON.stringify(currentConfig, null, 2), 'utf-8');

        console.log("✅ Config updated successfully.");
        return currentConfig;

    } catch (error) {
        console.error("❌ Config Update Error:", error);
        throw error;
    }
};
