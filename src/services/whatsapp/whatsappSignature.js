// src/services/whatsapp/whatsappSignature.js
// Verifies Meta's X-Hub-Signature-256 header: "sha256=" + HMAC-SHA256(rawBody, APP_SECRET).

import crypto from 'crypto';

const PREFIX = 'sha256=';

export function safeCompare(a, b) {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) {
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * @param {Buffer|string} rawBody    exact bytes Meta sent
 * @param {string} signatureHeader   value of X-Hub-Signature-256
 * @param {string} appSecret         Meta app secret
 * @returns {boolean}
 */
export function verifyWhatsAppSignature(rawBody, signatureHeader, appSecret) {
    if (!rawBody || !appSecret || typeof signatureHeader !== 'string') return false;
    if (!signatureHeader.startsWith(PREFIX)) return false;

    const expected = PREFIX + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
    return safeCompare(signatureHeader.trim().toLowerCase(), expected);
}
