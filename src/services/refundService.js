import crypto from 'crypto';
import logger from '../utils/logger.js';

const isSandbox = () => process.env.PAYFAST_SANDBOX === 'true';

const PAYFAST_REFUND_BASE_URL = () =>
    isSandbox()
        ? 'https://api.sandbox.payfast.co.za/refunds'
        : 'https://api.payfast.co.za/refunds';

/**
 * Generates a PayFast API timestamp in the exact required format:
 * YYYY-MM-DDTHH:MM:SS+HH:MM
 *
 * Matches the pattern used in queryRefund.js (reference file).
 */
const getTimestamp = () => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');

    const yyyy = now.getFullYear();
    const MM   = pad(now.getMonth() + 1);
    const dd   = pad(now.getDate());
    const HH   = pad(now.getHours());
    const mm   = pad(now.getMinutes());
    const ss   = pad(now.getSeconds());

    const offsetMin = -now.getTimezoneOffset();
    const sign      = offsetMin >= 0 ? '+' : '-';
    const absMin    = Math.abs(offsetMin);
    const offH      = pad(Math.floor(absMin / 60));
    const offM      = pad(absMin % 60);

    return `${yyyy}-${MM}-${dd}T${HH}:${mm}:${ss}${sign}${offH}:${offM}`;
};

/**
 * Generates the MD5 signature for PayFast API calls.
 *
 * Rules (from official PayFast docs & confirmed in queryRefund.js):
 *  1. Merge headersObj + passphrase into one object
 *  2. Sort all keys alphabetically
 *  3. URL-encode values (spaces → +)
 *  4. Join with & — no trailing &
 *  5. MD5 hash the resulting string
 *
 * @param {Object} headersObj  - { 'merchant-id', 'timestamp', 'version' }
 * @param {string} passphrase
 * @returns {string} MD5 hex signature
 */
const generateSignature = (headersObj, passphrase) => {
    const allParams = { ...headersObj, passphrase };

    const sortedKeys = Object.keys(allParams).sort();

    const encode = (val) =>
        encodeURIComponent(String(val).trim()).replace(/%20/g, '+');

    const paramString = sortedKeys
        .map((key) => `${key}=${encode(allParams[key])}`)
        .join('&');

    logger.info(`🔑 Refund Signature string: ${paramString}`);

    return crypto.createHash('md5').update(paramString).digest('hex');
};

/**
 * Builds PayFast auth headers for GET (Query) requests.
 * Signature only includes header fields — no body (GET has no body).
 */
const buildQueryHeaders = () => {
    const merchantId = process.env.PAYFAST_MERCHANT_ID;
    const passphrase = process.env.PAYFAST_PASSPHRASE;
    const version    = 'v1';
    const timestamp  = getTimestamp();

    const signaturePayload = {
        'merchant-id': merchantId,
        'timestamp'  : timestamp,
        'version'    : version,
    };

    const signature = generateSignature(signaturePayload, passphrase);

    return {
        'merchant-id'  : merchantId,
        'version'      : version,
        'timestamp'    : timestamp,
        'signature'    : signature,
        'Content-Type' : 'application/json',
    };
};

/**
 * Builds PayFast auth headers for POST (Create Refund) requests.
 *
 * IMPORTANT — Create Refund signature is different from Query:
 * Docs say: "MD5 hash of the alphabetised submitted HEADER and BODY variables"
 * So we must include all body fields in the signature too.
 *
 * @param {Object} bodyFields — the exact body object being sent to PayFast
 */
const buildCreateRefundHeaders = (bodyFields) => {
    const merchantId = process.env.PAYFAST_MERCHANT_ID;
    const passphrase = process.env.PAYFAST_PASSPHRASE;
    const version    = 'v1';
    const timestamp  = getTimestamp();

    // Combine headers + body for signature (as required by docs)
    const signaturePayload = {
        'merchant-id': merchantId,
        'timestamp'  : timestamp,
        'version'    : version,
        ...bodyFields,   // body fields included in signature
    };

    const signature = generateSignature(signaturePayload, passphrase);

    return {
        'merchant-id'  : merchantId,
        'version'      : version,
        'timestamp'    : timestamp,
        'signature'    : signature,
        'Content-Type' : 'application/json',
    };
};

// ─────────────────────────────────────────────────────────────────────────────
// QUERY REFUND
// GET /refunds/query/:pf_payment_id
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calls the PayFast Query Refund API.
 *
 * Returns eligibility data including:
 *  - token            (REQUIRED to create a refund — must be saved)
 *  - funding_type     (how the customer originally paid)
 *  - amount_available_for_refund
 *  - refund_full      (method: PAYMENT_SOURCE | BANK_PAYOUT | NOT_AVAILABLE)
 *  - refund_partial   (method: PAYMENT_SOURCE | BANK_PAYOUT | NOT_AVAILABLE)
 *  - bank_names       (list of valid banks — only relevant for BANK_PAYOUT)
 *  - status           (REFUNDABLE | NOT_AVAILABLE)
 *
 * @param {string} pfPaymentId — PayFast's pf_payment_id (gatewayTransactionId in our DB)
 * @returns {Object} PayFast query response
 */
export const queryPayFastRefund = async (pfPaymentId) => {
    const endpoint = `${PAYFAST_REFUND_BASE_URL()}/query/${pfPaymentId}`;
    const headers  = buildQueryHeaders();   // GET — signature is headers only

    logger.info(`📡 PayFast Query Refund: GET ${endpoint}`);

    const response = await fetch(endpoint, {
        method : 'GET',
        headers: headers,
    });

    const data = await response.json();

    if (!response.ok) {
        logger.error(`❌ PayFast Query Refund failed — HTTP ${response.status}: ${JSON.stringify(data)}`);
        throw new Error(`PayFast Query API failed: ${response.status} — ${JSON.stringify(data)}`);
    }

    logger.info(`✅ PayFast Query Refund success for pf_payment_id: ${pfPaymentId}`);
    logger.info(`📦 Query response: ${JSON.stringify(data, null, 2)}`);

    return data;
};

// ─────────────────────────────────────────────────────────────────────────────
// CREATE REFUND
// POST /refunds/:pf_payment_id
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calls the PayFast Create Refund API.
 *
 * @param {string} pfPaymentId — PayFast's pf_payment_id
 * @param {Object} payload     — refund request body (see below)
 *
 * payload for PAYMENT_SOURCE (card refund):
 * {
 *   amount       : "150.00",
 *   reason       : "Customer cancellation",
 *   notify_buyer : 1,
 *   token        : "abc123"   ← from saved queryResponse.token
 * }
 *
 * payload for BANK_PAYOUT (EFT / debit card fallback):
 * {
 *   amount              : "150.00",
 *   reason              : "Customer cancellation",
 *   notify_buyer        : 1,
 *   token               : "abc123",
 *   acc_holder          : "John Smith",
 *   bank_name           : "FNB",
 *   bank_branch_code    : "250655",
 *   bank_account_number : "1234567890"
 * }
 *
 * @returns {Object} PayFast create refund response
 */
/**
 * Calls the PayFast Create Refund API.
 *
 * Path   : POST /refunds/:pf_payment_id          (id in URL path)
 * Headers: merchant-id, version, timestamp, signature
 * Body   : amount (cents), reason, notify_buyer, [bank fields if BANK_PAYOUT]
 *
 * Signature for Create Refund = MD5(sorted(headers + body + passphrase))
 * This is DIFFERENT from Query where signature = MD5(sorted(headers + passphrase))
 *
 * @param {string} pfPaymentId — pf_payment_id goes in the URL path
 * @param {Object} payload     — body fields (amount in cents, reason, etc.)
 */
export const createPayFastRefund = async (pfPaymentId, payload) => {
    const endpoint = `${PAYFAST_REFUND_BASE_URL()}/${pfPaymentId}`;  // id in path

    // POST — signature must include body fields (per PayFast docs)
    const headers = buildCreateRefundHeaders(payload);

    logger.info(`📡 PayFast Create Refund: POST ${endpoint}`);
    logger.info(`📦 Refund payload (sent to PayFast): ${JSON.stringify(payload, null, 2)}`);

    const response = await fetch(endpoint, {
        method : 'POST',
        headers: headers,
        body   : JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
        logger.error(`❌ PayFast Create Refund failed — HTTP ${response.status}: ${JSON.stringify(data)}`);
        throw new Error(`PayFast Create Refund API failed: ${response.status} — ${JSON.stringify(data)}`);
    }

    logger.info(`✅ PayFast Create Refund success for pf_payment_id: ${pfPaymentId}`);
    logger.info(`📦 Create refund response: ${JSON.stringify(data, null, 2)}`);

    return data;
};
