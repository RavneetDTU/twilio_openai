// Additive internal APIs for BookiOps service-to-service calls.
// Protected by X-Internal-Api-Key. Does not alter certified public routes.

import { Router } from 'express';
import crypto from 'crypto';
import logger from '../utils/logger.js';
import { listTenants, updateTenantPhoneNumbers } from '../services/tenantService.js';

const router = Router();

function timingSafeEqualString(a, b) {
    const aBuf = Buffer.from(String(a || ''), 'utf8');
    const bBuf = Buffer.from(String(b || ''), 'utf8');
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
}

function requireInternalApiKey(req, res, next) {
    const expected = process.env.INTERNAL_API_KEY;
    if (!expected) {
        logger.error('INTERNAL_API_KEY is not configured');
        return res.status(503).json({ error: 'Internal API not configured' });
    }
    const provided = req.get('X-Internal-Api-Key') || '';
    if (!timingSafeEqualString(provided, expected)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    return next();
}

router.use(requireInternalApiKey);

/**
 * GET /api/internal/restaurants
 * Summary list for BookiOps directory sync.
 */
router.get('/restaurants', async (req, res) => {
    try {
        const restaurants = await listTenants();
        return res.status(200).json({
            restaurants,
            syncedAt: new Date().toISOString(),
            count: restaurants.length,
        });
    } catch (error) {
        logger.error(`❌ GET /api/internal/restaurants: ${error.message}`);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * PATCH /api/internal/restaurants/:id/phone-number
 * Narrow update: ONLY phoneNumbers + phoneIndex rebuild + cache invalidate.
 * Body: { phoneNumber: "+27..." } OR { phoneNumbers: ["+27..."] }
 */
router.patch('/restaurants/:id/phone-number', async (req, res) => {
    try {
        const restaurantId = req.params.id;
        const { phoneNumber, phoneNumbers } = req.body || {};

        let nextPhones;
        if (Array.isArray(phoneNumbers) && phoneNumbers.length) {
            nextPhones = phoneNumbers;
        } else if (typeof phoneNumber === 'string' && phoneNumber.trim()) {
            nextPhones = [phoneNumber.trim()];
        } else {
            return res.status(400).json({
                error: 'Provide phoneNumber (string) or phoneNumbers (non-empty array)',
            });
        }

        // Reject unexpected keys that could imply a general update API
        const allowed = new Set(['phoneNumber', 'phoneNumbers']);
        const extra = Object.keys(req.body || {}).filter((k) => !allowed.has(k));
        if (extra.length) {
            return res.status(400).json({
                error: `Unexpected fields not allowed: ${extra.join(', ')}. This endpoint only updates phone numbers.`,
            });
        }

        const result = await updateTenantPhoneNumbers(restaurantId, nextPhones);
        return res.status(200).json({
            message: 'Phone number updated',
            restaurantId: result.restaurantId,
            phoneNumbers: result.phoneNumbers,
            previousPhoneNumbers: result.previousPhoneNumbers,
        });
    } catch (error) {
        if (error.message.startsWith('Missing')) {
            return res.status(400).json({ error: error.message });
        }
        if (error.message.startsWith('Restaurant not found')) {
            return res.status(404).json({ error: error.message });
        }
        logger.error(`❌ PATCH /api/internal/restaurants/:id/phone-number: ${error.message}`);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

export default router;
