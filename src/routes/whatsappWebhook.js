// src/routes/whatsappWebhook.js
// =============================================================================
// WHATSAPP CLOUD API WEBHOOK — mounted at /webhook only when WHATSAPP_ENABLED=true
// =============================================================================
// GET  /webhook  Meta verification: hub.mode=subscribe + hub.verify_token → hub.challenge
// POST /webhook  X-Hub-Signature-256 checked on the raw body (req.rawBody, set by
//                the scoped express.json in server.js), then 200 at once and
//                the payload is processed in the background.
// =============================================================================

import express from 'express';
import admin, { db } from '../config/firebase.js';
import { getAvailableCapacityForDate } from '../services/capacityService.js';
import manualBookingService from '../services/manualBookingService.js';
import smsService from '../services/smsService.js';
import { getDefaultTenant, getTenantById, getTenantByPhone } from '../services/tenantService.js';
import logger from '../utils/logger.js';
import { createAvailabilityProvider } from '../services/whatsapp/whatsappAvailability.js';
import { createBookingAdapter } from '../services/whatsapp/whatsappBookingAdapter.js';
import whatsappClient from '../services/whatsapp/whatsappClient.js';
import { getWhatsAppConfig } from '../services/whatsapp/whatsappConfig.js';
import { createContactService } from '../services/whatsapp/whatsappContactService.js';
import { processWhatsAppWebhook, restaurantFromTenant } from '../services/whatsapp/whatsappProcessor.js';
import { createFirestoreSessionStore } from '../services/whatsapp/whatsappSessionStore.js';
import { safeCompare, verifyWhatsAppSignature } from '../services/whatsapp/whatsappSignature.js';

const router = express.Router();

async function resolveRestaurant(metadata) {
    const config = getWhatsAppConfig();
    let tenant = null;

    if (config.restaurantId) tenant = await getTenantById(config.restaurantId);

    const display = String(metadata?.display_phone_number || '').replace(/\D/g, '');
    if (!tenant && display) tenant = await getTenantByPhone(`+${display}`);

    if (!tenant) {
        logger.warn(`⚠️ [WhatsApp] No tenant for +${display || '?'} — routing to default (Billy's)`);
        tenant = await getDefaultTenant();
    }
    return restaurantFromTenant(tenant, config);
}

let deps = null;
function getDeps() {
    if (!deps) {
        deps = {
            store: createFirestoreSessionStore(db),
            client: whatsappClient,
            availability: createAvailabilityProvider(),
            booking: createBookingAdapter({
                getAvailableCapacityForDate,
                createManualBooking: (...args) => manualBookingService.createManualBooking(...args),
                paymentBaseUrl: smsService.paymentBaseUrl,
                getConfig: getWhatsAppConfig,
            }),
            contacts: createContactService({ db, FieldValue: admin.firestore.FieldValue }),
            resolveRestaurant,
            getConfig: getWhatsAppConfig,
        };
    }
    return deps;
}

router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const { verifyToken } = getWhatsAppConfig();

    if (mode === 'subscribe' && verifyToken && typeof token === 'string' && safeCompare(token, verifyToken)) {
        logger.info('✅ [WhatsApp] Webhook verified by Meta');
        return res.status(200).type('text/plain').send(String(challenge ?? ''));
    }

    logger.warn('⚠️ [WhatsApp] Webhook verification failed (mode or verify token mismatch)');
    return res.sendStatus(403);
});

router.post('/', (req, res) => {
    const { appSecret } = getWhatsAppConfig();
    if (!appSecret) {
        logger.error('❌ [WhatsApp] APP_SECRET is not set — rejecting webhook');
        return res.sendStatus(401);
    }
    if (!verifyWhatsAppSignature(req.rawBody, req.get('x-hub-signature-256'), appSecret)) {
        logger.warn('⚠️ [WhatsApp] Invalid X-Hub-Signature-256 — webhook rejected');
        return res.sendStatus(401);
    }

    res.sendStatus(200);

    const body = req.body;
    setImmediate(() => {
        processWhatsAppWebhook(body, getDeps())
            .catch((error) => logger.error(`❌ [WhatsApp] Webhook processing failed: ${error.stack || error.message}`));
    });
});

export default router;
