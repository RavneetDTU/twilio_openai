import fs from 'fs/promises';
import logger from './logger.js';
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
        logger.info(`📝 Updating config with: ${JSON.stringify(updates, null, 2)}`);

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

        // Replace questionFlow if provided
        if (updates.questionFlow) {
            restaurant.questionFlow = updates.questionFlow;
        }

        // 5. Update the restaurant in the array
        data.restaurants[restaurantIndex] = restaurant;

        // 6. Write File
        await fs.writeFile(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');

        logger.info(`✅ Config updated successfully for ${restaurant.name}`);
        return restaurant;

    } catch (error) {
        logger.error(`❌ Config Update Error: ${error.message}`);
        throw error;
    }
};

/**
 * Retrieves specific restaurant details from the configuration file.
 * @param {string} restaurantId - The ID of the restaurant.
 * @returns {Promise<Object>} - An object with name, depositAmount, and currency.
 */
export const getRestaurantDetails = async (restaurantId) => {
    try {
        const fileData = await fs.readFile(CONFIG_PATH, 'utf-8');
        const data = JSON.parse(fileData);

        const restaurant = data.restaurants.find(r => r.restaurantId === restaurantId);

        if (!restaurant) {
            throw new Error(`Restaurant not found with ID: ${restaurantId}`);
        }

        return restaurant;
    } catch (error) {
        console.log(`❌ Fetch Details Error: ${error.message}`);
        throw error;
    }
};
