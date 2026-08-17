/**
 * Backend-hosted PayFast checkout (HTML form + Direct Request split).
 * SMS links: {PAYMENT_FRONTEND_URL}/payment/{paymentId}
 * Point PAYMENT_FRONTEND_URL at this Jarvis host so split `setup` is posted.
 *
 * Booki = primary merchant (.env PAYFAST_*).
 * Restaurant = settings.payfastMerchantId (percentage, default 80).
 * ITN path unchanged.
 */

import express from 'express';
import { db } from '../config/firebase.js';
import {
    buildPayfastCheckoutFields,
    resolveSplitPaymentFromSettings,
} from '../services/payfastCheckoutService.js';
import { getRestaurantDetails } from '../utils/config.js';
import logger from '../utils/logger.js';

const router = express.Router();

async function loadBookingByPaymentId(paymentId) {
    const callLogsSnapshot = await db.collection('callLogs')
        .where('paymentId', '==', paymentId)
        .limit(1)
        .get();

    if (!callLogsSnapshot.empty) {
        return callLogsSnapshot.docs[0].data();
    }

    const manualSnapshot = await db.collection('manualBookings')
        .where('paymentId', '==', paymentId)
        .limit(1)
        .get();

    if (manualSnapshot.empty) return null;

    const manual = manualSnapshot.docs[0].data();
    return {
        paymentId: manual.paymentId,
        restaurantId: manual.restaurantId,
        restaurantName: manual.restaurantName,
        booking: {
            name: manual.name,
            phoneNo: manual.phoneNo,
            guests: manual.guests,
            date: manual.date,
            time: manual.time,
            allergy: manual.allergy,
            notes: manual.notes,
            bookingAmount: manual.bookingAmount || 0,
        },
    };
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderSimplePage(res, status, title, message) {
    res.status(status).type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>
  body{font-family:system-ui,sans-serif;background:#f8fafc;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:2rem;max-width:28rem;width:100%;text-align:center}
  h1{font-size:1.25rem;margin:0 0 .5rem} p{color:#64748b;font-size:.9rem;margin:0}
</style></head><body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div></body></html>`);
}

/** GET /payment-success — PayFast return_url */
export function paymentSuccessHandler(req, res) {
    renderSimplePage(
        res,
        200,
        'Payment received',
        'Thank you. Your deposit payment was submitted. You can close this page.'
    );
}

/** GET /payment-fail — PayFast cancel_url */
export function paymentFailHandler(req, res) {
    renderSimplePage(
        res,
        200,
        'Payment cancelled',
        'Your payment was cancelled. You can close this page or use the link in your SMS to try again.'
    );
}

/**
 * GET /payment/:paymentId
 * Serves a PayFast checkout form. Includes split `setup` when restaurant merchant is configured.
 */
router.get('/:paymentId', async (req, res) => {
    const { paymentId } = req.params;
    logger.info(`💳 Checkout page requested for paymentId: ${paymentId}`);

    try {
        const callData = await loadBookingByPaymentId(paymentId);
        if (!callData?.booking?.name) {
            return renderSimplePage(res, 404, 'Payment unavailable', 'No booking found for this payment link.');
        }

        const booking = callData.booking;
        const amount = Number(booking.bookingAmount);
        if (!Number.isFinite(amount) || amount <= 0) {
            return renderSimplePage(res, 400, 'Payment unavailable', 'This booking has no deposit amount to pay.');
        }

        let splitPayment = null;
        try {
            if (callData.restaurantId) {
                const restaurant = await getRestaurantDetails(callData.restaurantId);
                splitPayment = resolveSplitPaymentFromSettings(restaurant);
            }
        } catch (err) {
            logger.warn(`⚠️ Checkout: could not load restaurant for split: ${err.message}`);
        }

        const host = req.get('x-forwarded-host') || req.get('host');
        const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
        const origin = `${proto}://${host}`;

        const notifyUrl =
            process.env.PAYFAST_NOTIFY_URL ||
            `${origin}/api/payfast/notify`;

        const { fields, processUrl, splitApplied } = buildPayfastCheckoutFields({
            paymentId,
            booking,
            splitPayment,
            returnUrl: `${origin}/payment-success`,
            cancelUrl: `${origin}/payment-fail`,
            notifyUrl,
        });

        const hiddenInputs = Object.entries(fields)
            .map(([key, value]) =>
                `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`
            )
            .join('\n');

        const restaurantLabel = escapeHtml(callData.restaurantName || 'your reservation');
        const amountLabel = escapeHtml(amount.toFixed(2));
        const guestLabel = escapeHtml(booking.name);
        const splitNote = splitApplied
            ? `<p class="note">Payment will be split automatically: <strong>${escapeHtml(String(splitPayment.percentage))}%</strong> to the restaurant, remainder to Booki.</p>`
            : '';

        res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Pay deposit — Booki</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;background:#f1f5f9;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.25rem}
    .card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:2rem;max-width:26rem;width:100%;box-shadow:0 1px 2px rgba(0,0,0,.04)}
    .brand{font-size:.75rem;color:#64748b;margin:0 0 .35rem}
    h1{font-size:1.35rem;margin:0 0 .35rem;color:#0f172a}
    .sub{color:#64748b;font-size:.875rem;margin:0 0 1.25rem}
    dl{margin:0 0 1.5rem;padding:1rem;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0}
    .row{display:flex;justify-content:space-between;gap:1rem;font-size:.875rem;margin:.35rem 0}
    .row dt{color:#64748b} .row dd{margin:0;font-weight:600;color:#0f172a;text-align:right}
    .total{border-top:1px solid #e2e8f0;padding-top:.5rem;margin-top:.5rem}
    .total dd{font-size:1.05rem}
    button{width:100%;height:2.75rem;border:0;border-radius:8px;background:#1047a0;color:#fff;font-weight:600;font-size:.95rem;cursor:pointer}
    button:hover{opacity:.92}
    .note{font-size:.75rem;color:#64748b;margin:1rem 0 0;line-height:1.4}
  </style>
</head>
<body>
  <div class="card">
    <p class="brand">Booki</p>
    <h1>Complete your payment</h1>
    <p class="sub">Secure your deposit for ${restaurantLabel}.</p>
    <dl>
      <div class="row"><dt>Guest</dt><dd>${guestLabel}</dd></div>
      <div class="row"><dt>Guests</dt><dd>${escapeHtml(booking.guests ?? '—')}</dd></div>
      <div class="row"><dt>Date</dt><dd>${escapeHtml(booking.date || '—')}</dd></div>
      <div class="row"><dt>Time</dt><dd>${escapeHtml(booking.time || '—')}</dd></div>
      <div class="row total"><dt>Amount</dt><dd>R ${amountLabel}</dd></div>
    </dl>
    <form id="payfast-form" action="${escapeHtml(processUrl)}" method="post">
      ${hiddenInputs}
      <button type="submit">Pay with PayFast</button>
    </form>
    ${splitNote}
  </div>
</body>
</html>`);
    } catch (error) {
        logger.error(`❌ Checkout page error for ${paymentId}: ${error.message}`);
        return renderSimplePage(res, 500, 'Payment unavailable', error.message || 'Something went wrong.');
    }
});

export default router;
