// src/utils/config.js
// =============================================================================
// CONFIG UTILITIES — thin wrappers over tenantService
// =============================================================================
// All reads and writes now go to Firestore via tenantService.
// The prompts.json file is no longer read or written by this module.
// API route signatures are UNCHANGED — existing callers work without modification.
// =============================================================================

import logger from './logger.js';
import {
    getTenantById,
    updateTenant,
    addTenantQuestion,
    deleteTenantQuestion,
} from '../services/tenantService.js';

/**
 * Updates restaurant settings and/or operating hours.
 * Accepts the same body shape as before: { restaurantId, settings?, operatingHours?, questionFlow? }
 *
 * @param {Object} updates
 * @returns {Promise<Object>} Updated restaurant config
 */
export const updateConfig = async (updates) => {
    logger.info(`📝 updateConfig called for restaurantId: ${updates?.restaurantId}`);

    if (!updates?.restaurantId) {
        throw new Error('Missing required field: restaurantId');
    }

    return updateTenant(updates.restaurantId, {
        settings:       updates.settings,
        operatingHours: updates.operatingHours,
        questionFlow:   updates.questionFlow,
    });
};

/**
 * Retrieves full restaurant config by ID.
 * Identical return shape to the old JSON-based version.
 *
 * @param {string} restaurantId
 * @returns {Promise<Object>} Restaurant config object
 */
export const getRestaurantDetails = async (restaurantId) => {
    const tenant = await getTenantById(restaurantId);

    if (!tenant) {
        throw new Error(`Restaurant not found with ID: ${restaurantId}`);
    }

    return tenant;
};

/**
 * Adds a new question to a restaurant's questionFlow.
 * Auto-generates id and order — same behaviour as before.
 *
 * @param {string} restaurantId
 * @param {Object} newQuestion  { title, botMessage, isRequired, instructions? }
 * @returns {Promise<Object>} Updated restaurant config
 */
export const addQuestion = async (restaurantId, newQuestion) => {
    logger.info(`➕ addQuestion called for restaurantId: ${restaurantId}`);
    return addTenantQuestion(restaurantId, newQuestion);
};

/**
 * Deletes a question from a restaurant's questionFlow by its id.
 *
 * @param {string} restaurantId
 * @param {string} questionId   The q_<uuid> of the question to remove
 * @returns {Promise<Object>} Updated restaurant config
 */
export const deleteQuestion = async (restaurantId, questionId) => {
    logger.info(`🗑️ deleteQuestion called: ${questionId} from ${restaurantId}`);
    return deleteTenantQuestion(restaurantId, questionId);
};
