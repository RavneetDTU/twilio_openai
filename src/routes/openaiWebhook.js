// src/routes/openaiWebhook.js
// =============================================================================
// OPENAI REALTIME SIP — INCOMING CALL WEBHOOK
// =============================================================================
// Correlates X-Call-Sid → pendingSipCalls, accepts the OpenAI SIP call ASAP,
// opens the sideband, and signals /incoming-call that setup is ready so Twilio
// can answer the caller (who has been hearing ringback until then).
// =============================================================================

import { Router } from 'express';
import logger from '../utils/logger.js';
import { verifyOpenAIWebhook } from '../services/webhookVerifierService.js';
import { acceptOpenAICall, rejectOpenAICall } from '../services/openaiCallsService.js';
import { RealtimeSipSession } from '../services/realtimeSipSession.js';

const router = Router();

/**
 * CallSid → {
 *   persona, createdAt,
 *   resolveReady(session), rejectReady(err),
 *   openAiCallId?
 * }
 */
export const pendingSipCalls = new Map();

const PENDING_TTL_MS = 60000;

/** When true, orphan INVITEs (no local pendingSipCalls) are rejected. Default false
 *  so a second webhook consumer (e.g. production while testing on ngrok) cannot
 *  reject the call before this process accepts it. */
const REJECT_ORPHAN_SIP = process.env.OPENAI_REJECT_ORPHAN_SIP === 'true';

function sweepStalePendingCalls() {
    const now = Date.now();
    for (const [callSid, entry] of pendingSipCalls.entries()) {
        if (now - entry.createdAt > PENDING_TTL_MS) {
            logger.warn(`[SIP] Removing stale pending SIP correlation for CallSid ${callSid}.`);
            entry.rejectReady?.(new Error('Pending SIP correlation expired'));
            pendingSipCalls.delete(callSid);
        }
    }
}

router.post('/', async (req, res) => {
    let event;

    try {
        event = verifyOpenAIWebhook(req.rawBody, req.headers);
    } catch (error) {
        logger.warn(`[SIP Webhook] Unauthorized request signature: ${error.message} - IP: ${req.ip}`);
        return res.status(400).send('Invalid webhook signature');
    }

    logger.info(`[SIP Webhook] Verified event: ${event.type} (ID: ${event.id})`);

    // Accept BEFORE acknowledging when possible — shortens the race against any
    // other webhook endpoint that might reject this call_id as an "orphan".
    if (event.type === 'realtime.call.incoming') {
        try {
            await acceptIncomingCall(event);
        } catch (err) {
            logger.error(`[SIP Webhook] acceptIncomingCall failed for ${event.id}: ${err.message}`);
        }
        return res.status(200).json({ accepted: true, eventId: event.id });
    }

    res.status(200).json({ accepted: true, eventId: event.id });
});

/**
 * Accept + start sideband configure. Sideband completion resolves pendingSipCalls.
 */
async function acceptIncomingCall(event) {
    const { data } = event;
    sweepStalePendingCalls();

    const callId = data.call_id;
    const sipHeaders = data.sip_headers || [];
    const callSidHeader = sipHeaders.find((h) => h.name.toLowerCase() === 'x-call-sid')?.value;

    logger.info(`[SIP Webhook] Incoming call | call_id: ${callId} | Correlated CallSid: ${callSidHeader || 'MISSING'}`);

    if (!callSidHeader || !pendingSipCalls.has(callSidHeader)) {
        logger.error(
            `[SIP Webhook] No pending correlation for CallSid "${callSidHeader}" (call ${callId}). ` +
            (REJECT_ORPHAN_SIP
                ? 'Rejecting orphan.'
                : 'Leaving unanswered so another environment can accept. Set OPENAI_REJECT_ORPHAN_SIP=true in sole-owner production.')
        );
        if (REJECT_ORPHAN_SIP) {
            await rejectOpenAICall(callId);
        }
        return;
    }

    const entry = pendingSipCalls.get(callSidHeader);
    entry.openAiCallId = callId;
    const { persona, resolveReady, rejectReady } = entry;

    const acceptResult = await acceptOpenAICall(callId, persona);

    if (!acceptResult.ok) {
        pendingSipCalls.delete(callSidHeader);
        if (acceptResult.alreadyDecided) {
            logger.warn(
                `[SIP Webhook] Call ${callId} already decided — usually another webhook URL ` +
                `rejected/accepted this INVITE first. Point OpenAI's webhook at THIS server only.`
            );
            rejectReady?.(new Error('Call already decided'));
            return;
        }
        logger.error(`[SIP Webhook] Failed to accept call ${callId}: ${acceptResult.error}`);
        rejectReady?.(new Error(acceptResult.error || 'Accept failed'));
        return;
    }

    logger.info(`✅ [SIP Webhook] Call ${callId} accepted for "${persona.name}" — configuring sideband…`);

    // Sideband can continue after HTTP 200; /incoming-call is still holding ringback.
    configureSideband(callId, callSidHeader, persona, resolveReady, rejectReady).catch((err) => {
        logger.error(`[SIP Webhook] Sideband configure failed for ${callId}: ${err.message}`);
        pendingSipCalls.delete(callSidHeader);
        rejectReady?.(err);
    });
}

async function configureSideband(callId, callSidHeader, persona, resolveReady, rejectReady) {
    try {
        const session = new RealtimeSipSession(callId, callSidHeader, persona);
        await session.connectAndConfigure();
        if (pendingSipCalls.has(callSidHeader)) {
            resolveReady?.(session);
        }
    } catch (err) {
        pendingSipCalls.delete(callSidHeader);
        rejectReady?.(err);
        throw err;
    }
}

export default router;
