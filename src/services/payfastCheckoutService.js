import crypto from 'crypto';
import logger from '../utils/logger.js';

/**
 * PayFast checkout helpers (Direct Request Split Payments).
 * @see https://developers.payfast.co.za/docs#splitpayments
 *
 * Primary merchant = Booki (.env PAYFAST_MERCHANT_ID / KEY / PASSPHRASE).
 * Receiving merchant = restaurant settings.payfastMerchantId (percentage to them).
 * `setup` is NEVER included in the MD5 signature.
 */

const DEFAULT_SPLIT_PERCENTAGE = 80;

const isSandbox = () => process.env.PAYFAST_SANDBOX === 'true';

export const getPayfastProcessUrl = () =>
    isSandbox()
        ? 'https://sandbox.payfast.co.za/eng/process'
        : 'https://www.payfast.co.za/eng/process';

/**
 * @param {string|undefined|null} restaurantId
 * @param {Object|null} restaurantDetails - from getRestaurantDetails
 * @returns {{ merchant_id: number, percentage: number }|null}
 */
export function resolveSplitPaymentFromSettings(restaurantDetails) {
    const settings = restaurantDetails?.settings || {};
    const rawMerchantId = settings.payfastMerchantId;

    if (rawMerchantId === undefined || rawMerchantId === null || String(rawMerchantId).trim() === '') {
        return null;
    }

    const merchantId = Number(String(rawMerchantId).trim());
    if (!Number.isInteger(merchantId) || merchantId <= 0) {
        return null;
    }

    const rawPercentage = settings.payfastSplitPercentage;
    let percentage = DEFAULT_SPLIT_PERCENTAGE;
    if (rawPercentage !== undefined && rawPercentage !== null && String(rawPercentage).trim() !== '') {
        const parsed = Number(rawPercentage);
        if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 99) {
            percentage = parsed;
        }
    }

    return { merchant_id: merchantId, percentage };
}

/**
 * PayFast checkout signature — field insertion order; excludes setup + signature.
 */
export function generateCheckoutSignature(pfData, passPhrase = null) {
    let pfOutput = '';

    for (const key of Object.keys(pfData)) {
        if (key === 'setup' || key === 'signature') continue;
        const val = pfData[key];
        if (val !== '' && val !== null && val !== undefined) {
            pfOutput += `${key}=${encodeURIComponent(String(val).trim()).replace(/%20/g, '+')}&`;
        }
    }

    let getString = pfOutput.slice(0, -1);

    if (passPhrase !== null && passPhrase !== '') {
        getString += `&passphrase=${encodeURIComponent(String(passPhrase).trim()).replace(/%20/g, '+')}`;
    }

    return crypto.createHash('md5').update(getString).digest('hex');
}

/**
 * Build PayFast form fields for a booking payment.
 *
 * @param {Object} params
 * @param {string} params.paymentId
 * @param {Object} params.booking - { name, phoneNo, guests, date, time, bookingAmount }
 * @param {{ merchant_id: number, percentage: number }|null} params.splitPayment
 * @param {string} params.returnUrl
 * @param {string} params.cancelUrl
 * @param {string} [params.notifyUrl]
 * @returns {{ fields: Object, processUrl: string, splitApplied: boolean }}
 */
export function buildPayfastCheckoutFields({
    paymentId,
    booking,
    splitPayment,
    returnUrl,
    cancelUrl,
    notifyUrl,
}) {
    const merchantId = process.env.PAYFAST_MERCHANT_ID;
    const merchantKey = process.env.PAYFAST_MERCHANT_KEY;
    const passPhrase = process.env.PAYFAST_PASSPHRASE || null;

    if (!merchantId || !merchantKey) {
        throw new Error('Missing PAYFAST_MERCHANT_ID or PAYFAST_MERCHANT_KEY in .env');
    }

    const amount = Number(booking?.bookingAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('Invalid booking amount for PayFast checkout');
    }

    const nameParts = String(booking?.name || 'Guest').trim().split(/\s+/);
    const fields = {
        merchant_id: String(merchantId),
        merchant_key: String(merchantKey),
        return_url: returnUrl,
        cancel_url: cancelUrl,
    };

    if (notifyUrl) {
        fields.notify_url = notifyUrl;
    }

    fields.name_first = nameParts[0] || 'Guest';
    fields.name_last = nameParts.slice(1).join(' ') || 'Customer';

    if (booking?.phoneNo) {
        fields.cell_number = String(booking.phoneNo).replace(/\D/g, '');
    }

    fields.m_payment_id = paymentId;
    fields.amount = amount.toFixed(2);
    fields.item_name = `Booking for ${booking?.name || 'Guest'}`.substring(0, 100);

    const signature = generateCheckoutSignature(fields, passPhrase);
    fields.signature = signature;

    let splitApplied = false;
    if (splitPayment?.merchant_id != null && splitPayment?.percentage != null) {
        // setup after signature — must not be part of signature string
        fields.setup = JSON.stringify({
            split_payment: {
                merchant_id: Number(splitPayment.merchant_id),
                percentage: Number(splitPayment.percentage),
            },
        });
        splitApplied = true;
        logger.info(
            `💳 PayFast split applied for ${paymentId}: ` +
            `${splitPayment.percentage}% → merchant ${splitPayment.merchant_id}`
        );
    }

    return {
        fields,
        processUrl: getPayfastProcessUrl(),
        splitApplied,
    };
}

export { DEFAULT_SPLIT_PERCENTAGE };
