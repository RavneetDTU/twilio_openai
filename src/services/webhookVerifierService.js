// src/services/webhookVerifierService.js
// =============================================================================
// OPENAI WEBHOOK SIGNATURE VERIFICATION
// =============================================================================
// Verifies that incoming "realtime.call.incoming" webhooks genuinely originate
// from OpenAI, using the Standard Webhooks HMAC-SHA256 scheme.
// Ported from the SIP Trunking Demo Project (src/services/webhook-verifier.ts),
// translated to plain JS to match this project's ES Module conventions.
// =============================================================================

import crypto from 'crypto';
import logger from '../utils/logger.js';

/**
 * Constant-time string comparison to avoid timing-attack signature leaks.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeCompare(a, b) {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) {
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verifies the authenticity of an incoming webhook request from OpenAI and
 * returns the parsed event payload.
 *
 * @param {Buffer|undefined} rawBody - The raw request body buffer (must be captured
 *   BEFORE any JSON body-parsing middleware consumes the stream).
 * @param {Object} headers - The incoming request headers.
 * @returns {Object} The verified webhook event, parsed as JSON.
 * @throws {Error} If verification fails for any reason.
 */
export function verifyOpenAIWebhook(rawBody, headers) {
    if (!rawBody) {
        throw new Error('Missing raw body for signature verification.');
    }

    const webhookId = headers['webhook-id'];
    const webhookTimestamp = headers['webhook-timestamp'];
    const webhookSignature = headers['webhook-signature'];

    if (!webhookId || !webhookTimestamp || !webhookSignature) {
        throw new Error('Missing standard webhook headers (webhook-id, webhook-timestamp, or webhook-signature).');
    }

    // 1. Prevent replay attacks (5 minute tolerance window)
    const now = Math.floor(Date.now() / 1000);
    const timestampNumber = parseInt(String(webhookTimestamp), 10);
    const tolerance = 5 * 60;

    if (isNaN(timestampNumber) || Math.abs(now - timestampNumber) > tolerance) {
        throw new Error('Webhook timestamp is outside of acceptable 5-minute tolerance.');
    }

    // 2. Decode the base64 key portion of the webhook secret (format: whsec_<base64>)
    const secretKey = process.env.OPENAI_WEBHOOK_SECRET || '';
    if (!secretKey.startsWith('whsec_')) {
        throw new Error('Invalid or missing OPENAI_WEBHOOK_SECRET. Must start with "whsec_".');
    }

    const base64Secret = secretKey.substring(6);
    const secretBuffer = Buffer.from(base64Secret, 'base64');

    // 3. Construct the signed content and compute the expected signature
    const rawBodyString = rawBody.toString('utf8');
    const signedContent = `${webhookId}.${webhookTimestamp}.${rawBodyString}`;

    const computedSignature = crypto
        .createHmac('sha256', secretBuffer)
        .update(signedContent)
        .digest('base64');

    // 4. Parse the space-separated list of signatures (each prefixed "v1,")
    const signatureList = String(webhookSignature).split(' ');
    let verified = false;

    for (const item of signatureList) {
        const parts = item.split(',');
        if (parts[0] === 'v1') {
            const sigValue = parts[1];
            if (sigValue && safeCompare(sigValue, computedSignature)) {
                verified = true;
                break;
            }
        }
    }

    if (!verified) {
        throw new Error('Signature mismatch. Payload authenticity check failed.');
    }

    logger.debug('✅ OpenAI webhook signature verified successfully.');

    try {
        return JSON.parse(rawBodyString);
    } catch (err) {
        throw new Error(`Failed to parse raw webhook body JSON: ${err.message}`);
    }
}
