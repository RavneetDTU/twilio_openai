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
        const data = JSON.parse(fileData);

        // 2. Validation
        if (!updates.restaurantId) {
            throw new Error("Missing required field: restaurantId");
        }

        // 3. Find Restaurant by ID
        const restaurantIndex = data.restaurants.findIndex(r => r.restaurantId === updates.restaurantId);

        if (restaurantIndex === -1) {
            throw new Error(`Restaurant not found with ID: ${updates.restaurantId}`);
        }

        const restaurant = data.restaurants[restaurantIndex];

        // 4. Smart Merge
        // Merge settings if provided
        if (updates.settings) {
            restaurant.settings = {
                ...restaurant.settings,
                ...updates.settings
            };
        }

        // Merge operatingHours if provided
        if (updates.operatingHours) {
            restaurant.operatingHours = {
                ...restaurant.operatingHours,
                ...updates.operatingHours
            };
        }

        // 5. Update the restaurant in the array
        data.restaurants[restaurantIndex] = restaurant;

        // 6. Write File
        await fs.writeFile(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');

        console.log(`✅ Config updated successfully for ${restaurant.name}`);
        return restaurant;

    } catch (error) {
        console.error("❌ Config Update Error:", error);
        throw error;
    }
};
