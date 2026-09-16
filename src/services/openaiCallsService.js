// src/services/openaiCallsService.js
// =============================================================================
// OPENAI REALTIME SIP — CALL CONTROL REST CLIENT
// =============================================================================
// Thin REST wrapper around OpenAI's Realtime Calls API (accept / reject / refer).
// Ported from the SIP Trunking Demo Project (src/services/openai-calls.ts),
// adapted to accept the tenant persona (model + instructions) resolved by the
// existing dispatcher/promptBuilder instead of a single hardcoded prompt.
//
// NOTE: Call hangup is intentionally NOT implemented here. Hangup continues to
// use the existing Twilio REST mechanism (client.calls(callSid).update({status:
// 'completed'})) exactly as it does today for Media Stream calls — see
// src/services/realtimeSipSession.js. This keeps the auto-hangup behavior
// byte-for-byte identical to current production behavior.
// =============================================================================

import logger from '../utils/logger.js';

const { OPENAI_API_KEY, OPENAI_PROJECT_ID } = process.env;

/**
 * Auth headers for Realtime SIP REST (/accept, /reject, /refer) and the
 * sideband WebSocket. OpenAI looks up call_id in the project this header
 * selects; without it, /accept can 404 with "No session found for the
 * provided call_id" even though the webhook was verified. Must match the
 * user part of sip:{OPENAI_PROJECT_ID}@sip.api.openai.com.
 *
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string>}
 */
export function openaiSipHeaders(extra = {}) {
    const headers = {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        ...extra,
    };
    if (OPENAI_PROJECT_ID) {
        headers['OpenAI-Project'] = OPENAI_PROJECT_ID;
    }
    return headers;
}

/**
 * @typedef {Object} OpenAICallApiResult
 * @property {boolean} ok
 * @property {number} status
 * @property {Object} [body]
 * @property {string} [error]
 * @property {boolean} [alreadyDecided] - True if the caller hung up before we could accept/reject.
 */

function isAlreadyDecidedError(message) {
    return /decision has already been made/i.test(message || '');
}

/**
 * Accepts an incoming OpenAI Realtime SIP call and registers the model + system
 * instructions for the session. Per OpenAI's documented contract, the /accept
 * endpoint accepts ONLY { type, model, instructions } — voice, tools, and VAD
 * settings must be sent afterwards via session.update on the sideband WebSocket.
 *
 * @param {string} callId - The call_id from the realtime.call.incoming webhook.
 * @param {{ model: string, instructions: string }} persona - Resolved tenant persona.
 * @returns {Promise<OpenAICallApiResult>}
 */
export async function acceptOpenAICall(callId, persona) {
    const url = `https://api.openai.com/v1/realtime/calls/${callId}/accept`;

    const payload = {
        type: 'realtime',
        model: persona.model,
        instructions: persona.instructions,
    };

    if (!OPENAI_PROJECT_ID) {
        logger.warn('[SIP] OPENAI_PROJECT_ID is unset — /accept may 404 with call_id_not_found');
    }
    logger.info(`[SIP] Accepting call ${callId} for model "${payload.model}"...`);

    let attempts = 0;
    const maxAttempts = 3;
    const delayMs = 1000;

    while (attempts < maxAttempts) {
        attempts++;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: openaiSipHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(payload),
            });

            const responseText = await response.text();
            let responseBody = null;
            try {
                if (responseText) responseBody = JSON.parse(responseText);
            } catch (jsonErr) {
                logger.warn(`[SIP] Failed to parse accept response JSON on attempt ${attempts}: ${responseText}`);
            }

            if (!response.ok) {
                const errorMsg = responseBody?.error?.message || `HTTP ${response.status} ${response.statusText}`;
                const alreadyDecided = isAlreadyDecidedError(errorMsg);

                if (alreadyDecided) {
                    logger.warn(`[SIP] Call ${callId} was already accepted/rejected — caller likely hung up during ringback.`);
                    return { ok: false, status: response.status, error: errorMsg, body: responseBody, alreadyDecided: true };
                }

                logger.error(`[SIP] Accept attempt ${attempts}/${maxAttempts} failed for ${callId}: ${errorMsg}`);

                if (response.status >= 500 && attempts < maxAttempts) {
                    await new Promise((resolve) => setTimeout(resolve, delayMs * attempts));
                    continue;
                }

                return { ok: false, status: response.status, error: errorMsg, body: responseBody };
            }

            logger.info(`[SIP] Call ${callId} accepted successfully.`);
            return { ok: true, status: response.status, body: responseBody };
        } catch (error) {
            logger.error(`[SIP] Network/timeout error accepting call ${callId} on attempt ${attempts}/${maxAttempts}: ${error.message}`);
            if (attempts < maxAttempts) {
                await new Promise((resolve) => setTimeout(resolve, delayMs * attempts));
                continue;
            }
            return { ok: false, status: 500, error: error.message || 'Network error accepting call' };
        }
    }

    return { ok: false, status: 500, error: 'Max retry attempts exceeded' };
}

/**
 * Rejects an incoming OpenAI Realtime SIP call.
 * @param {string} callId
 * @param {number} [statusCode] - Optional SIP status code (defaults to 603 on OpenAI's side).
 * @returns {Promise<OpenAICallApiResult>}
 */
export async function rejectOpenAICall(callId, statusCode) {
    const url = `https://api.openai.com/v1/realtime/calls/${callId}/reject`;
    const payload = statusCode ? { status_code: statusCode } : {};

    logger.info(`[SIP] Rejecting call ${callId}...`);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: openaiSipHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(payload),
        });

        const responseText = await response.text();
        let responseBody = null;
        if (responseText) {
            try { responseBody = JSON.parse(responseText); } catch { /* ignore non-JSON */ }
        }

        if (!response.ok) {
            const errorMsg = responseBody?.error?.message || `HTTP ${response.status} ${response.statusText}`;
            logger.error(`[SIP] Reject failed for call ${callId}: ${errorMsg}`);
            return { ok: false, status: response.status, error: errorMsg, body: responseBody };
        }

        logger.info(`[SIP] Call ${callId} rejected successfully.`);
        return { ok: true, status: response.status, body: responseBody };
    } catch (error) {
        logger.error(`[SIP] Network error rejecting call ${callId}: ${error.message}`);
        return { ok: false, status: 500, error: error.message };
    }
}

/**
 * Refers (transfers) an active OpenAI Realtime SIP call to another SIP/tel URI.
 * Not used by the current migration scope, but ported for completeness/parity
 * with the demo project in case warm-transfer is requested later.
 * @param {string} callId
 * @param {string} targetUri
 * @returns {Promise<OpenAICallApiResult>}
 */
export async function referOpenAICall(callId, targetUri) {
    const url = `https://api.openai.com/v1/realtime/calls/${callId}/refer`;
    const payload = { target_uri: targetUri };

    logger.info(`[SIP] Referring call ${callId} to ${targetUri}...`);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: openaiSipHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(payload),
        });

        const responseText = await response.text();
        let responseBody = null;
        if (responseText) {
            try { responseBody = JSON.parse(responseText); } catch { /* ignore non-JSON */ }
        }

        if (!response.ok) {
            const errorMsg = responseBody?.error?.message || `HTTP ${response.status} ${response.statusText}`;
            logger.error(`[SIP] Refer failed for call ${callId}: ${errorMsg}`);
            return { ok: false, status: response.status, error: errorMsg, body: responseBody };
        }

        logger.info(`[SIP] Call ${callId} referred successfully.`);
        return { ok: true, status: response.status, body: responseBody };
    } catch (error) {
        logger.error(`[SIP] Network error referring call ${callId}: ${error.message}`);
        return { ok: false, status: 500, error: error.message };
    }
}
