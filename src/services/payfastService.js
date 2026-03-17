import crypto from 'crypto';
import dns from 'dns';
import logger from '../utils/logger.js';

/**
 * Payfast ITN (Instant Transaction Notification) Validation Service
 *
 * Handles all security checks required by Payfast (official docs order):
 * 1. MD5 Signature validation
 * 2. Valid Payfast domain check (DNS lookup)
 * 3. Amount verification
 * 4. Server-to-server confirmation
 */

// Official Payfast valid domains (from Payfast documentation)
const PAYFAST_VALID_DOMAINS = [
    'www.payfast.co.za',
    'sandbox.payfast.co.za',
    'w1w.payfast.co.za',
    'w2w.payfast.co.za'
];

// Sandbox mode flag
const isSandbox = () => process.env.PAYFAST_SANDBOX === 'true';

/**
 * Resolve all IP addresses for a given domain.
 * @param {string} domain
 * @returns {Promise<string[]>}
 */
const ipLookup = (domain) => {
    return new Promise((resolve, reject) => {
        dns.lookup(domain, { all: true }, (err, addresses) => {
            if (err) {
                reject(err);
            } else {
                resolve(addresses.map(item => item.address));
            }
        });
    });
};

/**
 * Validate the MD5 signature sent by Payfast.
 * 
 * Steps:
 * 1. Take all POST body fields EXCEPT 'signature'
 * 2. Sort them alphabetically by key
 * 3. URL-encode each value and join with '&'
 * 4. Append passphrase if set
 * 5. Generate MD5 hash and compare
 * 
 * @param {Object} data - The full POST body from Payfast
 * @param {string|null} passphrase - Your Payfast passphrase from .env
 * @returns {boolean} - Whether the signature is valid
 */
export const validateSignature = (data, passphrase) => {
    try {
        const receivedSignature = data.signature;
        if (!receivedSignature) {
            logger.error('❌ Payfast ITN: No signature found in request');
            return false;
        }

        // Build the parameter string exactly as Payfast expects
        let pfParamString = '';
        for (const key in data) {
            if (Object.prototype.hasOwnProperty.call(data, key) && key !== 'signature') {
                pfParamString += `${key}=${encodeURIComponent(data[key].trim()).replace(/%20/g, '+')}&`;
            }
        }

        // Remove last ampersand
        pfParamString = pfParamString.slice(0, -1);

        if (passphrase !== null && passphrase !== '') {
            pfParamString += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, '+')}`;
        }

        const generatedSignature = crypto.createHash('md5').update(pfParamString).digest('hex');
        const isValid = generatedSignature === receivedSignature;

        if (!isValid) {
            logger.error(`❌ Payfast ITN: Signature mismatch — expected (generated): ${generatedSignature}, received: ${receivedSignature}`);
        } else {
            logger.info('✅ Payfast ITN: Signature validated successfully');
        }

        return isValid;
    } catch (error) {
        logger.error(`❌ Payfast ITN: Signature validation error: ${error.message}`);
        return false;
    }
};

/**
 * Validate that the request has originated from a legitimate Payfast domain.
 * Resolves the current IPs for all known Payfast domains via DNS and checks
 * whether the incoming request IP is among them.
 *
 * Per official Payfast docs — dynamic DNS resolution is preferred over a
 * hardcoded IP list because Payfast can change IPs (e.g. AWS migration).
 *
 * @param {import('express').Request} req - The Express request object
 * @returns {Promise<boolean>}
 */
export const validatePayfastDomain = async (req) => {
    // In sandbox mode skip domain check — sandbox IPs may not resolve via DNS
    if (isSandbox()) {
        const pfIp = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || req.ip;
        logger.info(`ℹ️ Payfast ITN: Sandbox mode — skipping domain validation (IP: ${pfIp})`);
        return true;
    }

    const pfIp = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || req.ip;

    let validIps = [];

    try {
        for (const domain of PAYFAST_VALID_DOMAINS) {
            const ips = await ipLookup(domain);
            validIps = [...validIps, ...ips];
        }
    } catch (err) {
        logger.error(`❌ Payfast ITN: DNS lookup failed: ${err.message}`);
        return false;
    }

    // Deduplicate
    const uniqueIps = [...new Set(validIps)];

    if (uniqueIps.includes(pfIp)) {
        logger.info(`✅ Payfast ITN: Valid Payfast domain IP: ${pfIp}`);
        return true;
    }

    logger.error(`❌ Payfast ITN: Request IP not from a valid Payfast domain: ${pfIp}`);
    return false;
};

/**
 * Confirm the transaction with Payfast's server (server-to-server validation).
 * 
 * Sends all received data back to Payfast's validation endpoint.
 * Payfast responds with "VALID" or "INVALID".
 * 
 * @param {Object} data - The full POST body from Payfast (excluding signature)
 * @returns {Promise<boolean>} - Whether Payfast confirmed the transaction
 */
export const confirmWithPayfast = async (data) => {
    try {
        const baseUrl = isSandbox()
            ? 'https://sandbox.payfast.co.za/eng/query/validate'
            : 'https://www.payfast.co.za/eng/query/validate';

        // Build URL-encoded param string from all fields except 'signature'
        // (same format as the original pfParamString used in signature validation)
        const params = { ...data };
        delete params.signature;

        let pfParamString = '';
        for (const key in params) {
            if (Object.prototype.hasOwnProperty.call(params, key)) {
                pfParamString += `${key}=${encodeURIComponent(String(params[key]).trim()).replace(/%20/g, '+')}\u0026`;
            }
        }
        const paramString = pfParamString.slice(0, -1);

        logger.info(`📡 Payfast ITN: Confirming with Payfast at ${baseUrl}`);

        const response = await fetch(baseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: paramString
        });

        const responseText = await response.text();
        const isValid = responseText.trim() === 'VALID';

        if (!isValid) {
            logger.error(`❌ Payfast ITN: Server confirmation failed — response: ${responseText}`);
        } else {
            logger.info('✅ Payfast ITN: Server confirmation successful');
        }

        return isValid;
    } catch (error) {
        logger.error(`❌ Payfast ITN: Server confirmation error: ${error.message}`);
        return false;
    }
};

/**
 * Verify that the amount received matches the expected amount.
 * 
 * @param {number|string} receivedAmount - amount_gross from Payfast
 * @param {number|string} expectedAmount - bookingAmount from your DB
 * @returns {boolean}
 */
export const validateAmount = (receivedAmount, expectedAmount) => {
    const received = parseFloat(receivedAmount);
    const expected = parseFloat(expectedAmount);

    // Allow a small tolerance for floating point differences (1 cent)
    const isValid = Math.abs(received - expected) < 0.01;

    if (!isValid) {
        logger.error(`❌ Payfast ITN: Amount mismatch — received: ${received}, expected: ${expected}`);
    } else {
        logger.info(`✅ Payfast ITN: Amount verified — R${received}`);
    }

    return isValid;
};
