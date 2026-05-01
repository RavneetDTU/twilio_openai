import express from 'express';
import crypto from 'crypto';
import { db } from '../config/firebase.js';
import logger from '../utils/logger.js';
import { queryPayFastRefund, createPayFastRefund } from '../services/refundService.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Get current SA date and time strings
// ─────────────────────────────────────────────────────────────────────────────
const getSADateTime = () => {
    const now  = new Date();
    const date = now.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' }); // "YYYY-MM-DD"
    const time = now.toLocaleTimeString('en-GB', { timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit', hour12: false }); // "HH:mm"
    return { date, time };
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Sync refund status to External Reservation API
// Only sends payment_status and payment_notes — all other fields are unchanged.
// ─────────────────────────────────────────────────────────────────────────────
const syncRefundToExternalApi = async ({ restaurantId, paymentId, paymentStatus, paymentNotes }) => {
    const externalApiUrl = `https://mybookiapis.jarviscalling.ai/restaurants/${restaurantId}/reservations/by-reference/${paymentId}`;

    const payload = {
        payment_status: paymentStatus,
        payment_notes : paymentNotes,
    };

    logger.info(`📡 Syncing refund status to External API: ${externalApiUrl}`);
    logger.info(`📦 External API payload: ${JSON.stringify(payload)}`);

    const response = await fetch(externalApiUrl, {
        method : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify(payload),
    });

    if (!response.ok) {
        const errText = await response.text();
        logger.error(`❌ External API sync failed for ${paymentId}. Status: ${response.status}. Error: ${errText}`);
    } else {
        logger.info(`✅ External API sync successful for refund on ${paymentId}`);
    }
};


// =============================================================================
// GET /api/refund/query/:gatewayTransactionId
//
// Step 1 of the refund flow.
// Pass the gatewayTransactionId (pf_payment_id from PayFast) directly.
// The route looks up the payment in Firebase using that value.
//
// Frontend uses the response to:
//  - Show/hide bank details form  (needsBankDetailsForFull / needsBankDetailsForPartial)
//  - Populate bank dropdown       (availableBanks)
//  - Set max refund amount        (maxRefundable)
//  - Enable/disable full refund   (fullRefundAvailable)
// =============================================================================
router.get('/query/:gatewayTransactionId', async (req, res) => {
    const { gatewayTransactionId } = req.params;

    logger.info(`🔍 Refund Query request for gatewayTransactionId: ${gatewayTransactionId}`);

    try {
        // ── 1. Load payment from Firebase by gatewayTransactionId ──────────
        // We still need the payment doc for: status check, refundStatus,
        // amount validation, restaurantId, and paymentId for the initiate flow.
        const snapshot = await db.collection('payments')
            .where('gatewayTransactionId', '==', gatewayTransactionId)
            .limit(1)
            .get();

        if (snapshot.empty) {
            logger.error(`❌ Refund Query: No payment found for gatewayTransactionId — ${gatewayTransactionId}`);
            return res.status(404).json({ success: false, error: 'No payment found for this gatewayTransactionId' });
        }

        const payment   = snapshot.docs[0].data();
        const paymentId = payment.paymentId;

        logger.info(`📋 Payment found — paymentId: ${paymentId} | status: ${payment.status} | refundStatus: ${payment.refundStatus || 'none'}`);

        // ── 2. Guard: payment must be successful ───────────────────────────
        if (payment.status !== 'success') {
            return res.status(400).json({
                success: false,
                error  : 'Refund not applicable — payment is not in success state',
            });
        }

        // ── 3. Guard: already fully refunded ──────────────────────────────
        if (payment.refundStatus === 'refunded') {
            return res.status(400).json({
                success: false,
                error  : 'This payment has already been fully refunded',
            });
        }

        // ── 4. Call PayFast Query API ──────────────────────────────────────
        // gatewayTransactionId IS the pf_payment_id — pass it directly
        const queryData = await queryPayFastRefund(gatewayTransactionId);

        // ── 4a. Log the full structured PayFast query response ─────────────
        logger.info('━'.repeat(60));
        logger.info(`📋 PAYFAST QUERY RESPONSE — gatewayTransactionId: ${gatewayTransactionId}`);
        logger.info('━'.repeat(60));
        logger.info(`   token                      : ${queryData.token}`);
        logger.info(`   funding_type               : ${queryData.funding_type}`);
        logger.info(`   status                     : ${queryData.status}`);
        logger.info(`   amount_original            : R${((queryData.amount_original || 0) / 100).toFixed(2)}`);
        logger.info(`   amount_available_for_refund: R${((queryData.amount_available_for_refund || 0) / 100).toFixed(2)}`);
        logger.info(`   refund_full.method         : ${queryData.refund_full?.method}`);
        logger.info(`   refund_partial.method      : ${queryData.refund_partial?.method}`);
        logger.info(`   bank_names                 : ${JSON.stringify(queryData.bank_names)}`);
        logger.info(`   errors                     : ${JSON.stringify(queryData.errors)}`);
        logger.info('   --- Full raw object ---');
        logger.info(JSON.stringify(queryData, null, 2));
        logger.info('━'.repeat(60));

        // ── 5. Determine what the frontend needs to show ───────────────────
        const fullRefundMethod    = queryData.refund_full?.method;
        const partialRefundMethod = queryData.refund_partial?.method;

        const fullRefundAvailable    = fullRefundMethod !== 'NOT_AVAILABLE';
        const partialRefundAvailable = partialRefundMethod !== 'NOT_AVAILABLE';

        const needsBankDetailsForFull    = fullRefundMethod === 'BANK_PAYOUT';
        const needsBankDetailsForPartial = partialRefundMethod === 'BANK_PAYOUT';

        const availableBanks = queryData.bank_names || [];
        const maxRefundable  = (queryData.amount_available_for_refund || 0) / 100;

        logger.info(`✅ Refund Query complete | maxRefundable: R${maxRefundable} | fullAvailable: ${fullRefundAvailable}`);

        return res.json({
            success: true,
            paymentId,
            gatewayTransactionId,
            fundingType              : queryData.funding_type,
            status                   : queryData.status,
            maxRefundable,
            fullRefundAvailable,
            partialRefundAvailable,
            needsBankDetailsForFull,
            needsBankDetailsForPartial,
            availableBanks,
            _raw: queryData,
        });

    } catch (error) {
        logger.error(`❌ Refund Query error for gatewayTransactionId ${gatewayTransactionId}: ${error.message}`);
        return res.status(500).json({ success: false, error: 'Internal server error', message: error.message });
    }
});


// =============================================================================
// POST /api/refund/initiate
//
// Step 2 of the refund flow — the actual refund creation.
//
// Request body:
// {
//   "paymentId"    : "your-internal-payment-id",   REQUIRED
//   "amount"       : 150.00,                        REQUIRED (in Rands)
//   "reason"       : "Customer cancellation",       REQUIRED
//   "isFullRefund" : true | false,                  REQUIRED
//
//   --- Only required when refund method is BANK_PAYOUT ---
//   "accHolder"         : "John Smith",
//   "bankName"          : "FNB",
//   "bankBranchCode"    : "250655",
//   "bankAccountNumber" : "1234567890"
// }
//
// What it does:
//  1. Validates the payment exists and is eligible
//  2. Idempotency check — blocks if a refund is already in-flight
//  3. Writes refund doc with status 'initiated' (idempotency anchor)
//  4. Calls PayFast Query API to get token + method
//  5. Validates query response (amount, availability)
//  6. Builds and sends PayFast Create Refund request
//  7. Updates Firebase (refund doc + payment doc summary) atomically
//  8. Syncs payment_status and payment_notes to External API
// =============================================================================
router.post('/initiate', async (req, res) => {
    const {
        paymentId,
        amount,
        reason,
        isFullRefund,
        // Bank details — only needed if BANK_PAYOUT
        accHolder,
        bankName,
        bankBranchCode,
        bankAccountNumber,
        bankAccountType,   // 'current' or 'savings' — REQUIRED for BANK_PAYOUT
    } = req.body;

    logger.info(`💸 Refund Initiate request for paymentId: ${paymentId} | Amount: R${amount} | Full: ${isFullRefund}`);

    // ── Basic input validation ───────────────────────────────────────────────
    if (!paymentId || amount === undefined || amount === null || !reason) {
        return res.status(400).json({
            success: false,
            error  : 'Missing required fields: paymentId, amount, reason',
        });
    }

    const requestedAmount = parseFloat(amount);
    if (isNaN(requestedAmount) || requestedAmount <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid amount — must be a positive number' });
    }

    try {
        // ── 1. Load payment from Firebase by gatewayTransactionId ───────────
        const snapshot = await db.collection('payments')
            .where('gatewayTransactionId', '==', paymentId)
            .limit(1)
            .get();

        // Fallback: if not found by gatewayTransactionId, try by internal paymentId doc ID
        let payment = null;

        if (!snapshot.empty) {
            payment = snapshot.docs[0].data();
        } else {
            const directDoc = await db.collection('payments').doc(paymentId).get();
            if (directDoc.exists) {
                payment = directDoc.data();
            }
        }

        if (!payment) {
            logger.error(`❌ Refund Initiate: Payment not found — ${paymentId}`);
            return res.status(404).json({ success: false, error: 'Payment not found' });
        }

        // Use the internal paymentId from the payment document (always correct)
        const internalPaymentId = payment.paymentId;

        logger.info(`📋 Payment loaded: ${internalPaymentId} | Status: ${payment.status} | Amount: R${payment.amount} | RefundStatus: ${payment.refundStatus || 'none'}`);

        // ── 2. Guard: must be a successful payment ───────────────────────────
        if (payment.status !== 'success') {
            return res.status(400).json({ success: false, error: 'Cannot refund — payment is not in success state' });
        }

        // ── 3. Guard: fully refunded already ─────────────────────────────────
        if (payment.refundStatus === 'refunded') {
            return res.status(400).json({ success: false, error: 'This payment has already been fully refunded' });
        }

        // ── 4. Guard: amount would exceed original ───────────────────────────
        const alreadyRefunded = payment.refundedAmount || 0;
        if (requestedAmount + alreadyRefunded > payment.amount + 0.01) {
            return res.status(400).json({
                success: false,
                error  : `Refund amount exceeds available balance. Already refunded: R${alreadyRefunded}. Original: R${payment.amount}`,
            });
        }

        const pfPaymentId = payment.gatewayTransactionId;
        if (!pfPaymentId) {
            return res.status(400).json({ success: false, error: 'No PayFast transaction ID found for this payment' });
        }

        // ── 5. Idempotency check — block if refund already in-flight ─────────
        const inFlightCheck = await db.collection('refunds')
            .where('paymentId', '==', internalPaymentId)
            .where('status', 'in', ['initiated', 'processing', 'completed'])
            .limit(1)
            .get();

        if (!inFlightCheck.empty) {
            const existingRefund = inFlightCheck.docs[0].data();
            logger.warn(`⚠️ Refund already exists for ${internalPaymentId} — status: ${existingRefund.status}`);
            return res.status(409).json({
                success: false,
                error  : `A refund is already ${existingRefund.status} for this payment`,
                refundId: existingRefund.refundId,
            });
        }

        // ── 6. Write 'initiated' to Firebase — IDEMPOTENCY ANCHOR ───────────
        // This is written BEFORE calling PayFast to prevent race conditions.
        const refundId  = `rfnd_${crypto.randomUUID()}`;
        const refundRef = db.collection('refunds').doc(refundId);

        const refundDoc = {
            refundId,
            paymentId        : internalPaymentId,
            pf_payment_id    : pfPaymentId,
            restaurantId     : payment.restaurantId,
            requestedAmount,
            isFullRefund     : !!isFullRefund,
            reason           : reason.trim(),
            status           : 'initiated',
            refundMethod     : null,   // filled after query
            queryResponse    : null,   // filled after query
            createRefundResponse: null,
            externalApiSynced   : false,
            createdAt        : new Date(),
            updatedAt        : new Date(),
        };

        await refundRef.set(refundDoc);
        logger.info(`✅ Refund doc created with status 'initiated' — refundId: ${refundId}`);

        // ── 7. Call PayFast Query API ─────────────────────────────────────────
        let queryData;
        try {
            queryData = await queryPayFastRefund(pfPaymentId);
        } catch (queryError) {
            logger.error(`❌ PayFast Query failed for refund ${refundId}: ${queryError.message}`);
            await refundRef.update({ status: 'query_failed', updatedAt: new Date() });
            return res.status(502).json({ success: false, error: 'PayFast Query API failed', message: queryError.message });
        }

        // ── 8. Validate query response ────────────────────────────────────────
        if (queryData.status !== 'REFUNDABLE') {
            logger.error(`❌ Payment not refundable — status: ${queryData.status}`);
            await refundRef.update({ status: 'query_failed', queryResponse: queryData, updatedAt: new Date() });
            return res.status(400).json({ success: false, error: `PayFast says payment is not refundable (status: ${queryData.status})` });
        }

        // Amount available (PayFast returns in cents)
        const availableInRands = (queryData.amount_available_for_refund || 0) / 100;
        if (requestedAmount > availableInRands + 0.01) {
            logger.error(`❌ Requested R${requestedAmount} exceeds PayFast available R${availableInRands}`);
            await refundRef.update({ status: 'validation_failed', queryResponse: queryData, updatedAt: new Date() });
            return res.status(400).json({
                success: false,
                error  : `Requested amount R${requestedAmount} exceeds PayFast available amount R${availableInRands}`,
            });
        }

        // Check full/partial availability
        const fullMethod    = queryData.refund_full?.method;
        const partialMethod = queryData.refund_partial?.method;

        if (isFullRefund && fullMethod === 'NOT_AVAILABLE') {
            await refundRef.update({ status: 'validation_failed', queryResponse: queryData, updatedAt: new Date() });
            return res.status(400).json({ success: false, error: 'Full refund is not available for this payment' });
        }

        if (!isFullRefund && partialMethod === 'NOT_AVAILABLE') {
            await refundRef.update({ status: 'validation_failed', queryResponse: queryData, updatedAt: new Date() });
            return res.status(400).json({ success: false, error: 'Partial refund is not available for this payment' });
        }

        // Determine which method applies
        const refundMethod = isFullRefund ? fullMethod : partialMethod; // 'PAYMENT_SOURCE' | 'BANK_PAYOUT'

        // If BANK_PAYOUT, validate bank details were provided
        if (refundMethod === 'BANK_PAYOUT') {
            if (!accHolder || !bankName || !bankBranchCode || !bankAccountNumber || !bankAccountType) {
                await refundRef.update({ status: 'validation_failed', queryResponse: queryData, updatedAt: new Date() });
                return res.status(400).json({
                    success: false,
                    error  : 'Bank details required for BANK_PAYOUT: accHolder, bankName, bankBranchCode, bankAccountNumber, bankAccountType (current | savings)',
                });
            }
            if (!['current', 'savings'].includes(bankAccountType.toLowerCase())) {
                await refundRef.update({ status: 'validation_failed', queryResponse: queryData, updatedAt: new Date() });
                return res.status(400).json({
                    success: false,
                    error  : 'bankAccountType must be either "current" or "savings"',
                });
            }
        }

        // Save query response to refund doc
        await refundRef.update({
            queryResponse: queryData,
            refundMethod,
            status       : 'processing',
            updatedAt    : new Date(),
        });

        logger.info(`📋 Refund ${refundId} — method: ${refundMethod} | token: ${queryData.token}`);

        // ── 9. Build PayFast Create Refund payload ────────────────────────────
        // ⚠️  amount must be in CENTS (integer) — docs: "the amount to refund in cents (ZAR)"
        // ⚠️  token is NOT a documented body param — not included
        const payfastPayload = {
            amount       : Math.round(requestedAmount * 100),  // Rands → cents
            reason       : reason.trim(),
            notify_buyer : 1,
            notify_merchant: 0,
        };

        if (refundMethod === 'BANK_PAYOUT') {
            // Field names per PayFast docs (acc_holder, bank_name, bank_branch_code,
            // bank_account_number, acc_type are the documented field names)
            payfastPayload.acc_holder          = accHolder.trim();
            payfastPayload.bank_name           = bankName.trim();
            payfastPayload.bank_branch_code    = parseInt(bankBranchCode);       // integer per docs
            payfastPayload.bank_account_number = parseInt(bankAccountNumber);    // integer per docs
            payfastPayload.acc_type            = bankAccountType.toLowerCase();  // 'current' | 'savings'
        }

        // ── 10. Call PayFast Create Refund API ────────────────────────────────
        let createRefundResponse;
        try {
            createRefundResponse = await createPayFastRefund(pfPaymentId, payfastPayload);
        } catch (createError) {
            logger.error(`❌ PayFast Create Refund failed for ${refundId}: ${createError.message}`);
            await refundRef.update({
                status              : 'failed',
                createRefundResponse: { error: createError.message },
                updatedAt           : new Date(),
            });

            // Sync failure to external API (payment status unchanged — refund failed)
            try {
                await syncRefundToExternalApi({
                    restaurantId : payment.restaurantId,
                    paymentId    : internalPaymentId,
                    paymentStatus: 'Refund Failed',
                    paymentNotes : `Refund attempt of R${requestedAmount} failed. Original payment stands.`,
                });
            } catch (syncErr) {
                logger.error(`❌ External API sync error (refund failed): ${syncErr.message}`);
            }

            return res.status(502).json({ success: false, error: 'PayFast Create Refund API failed', message: createError.message });
        }

        // ── 11. Update Firebase atomically ────────────────────────────────────
        const newRefundedTotal      = alreadyRefunded + requestedAmount;
        const refundableRemaining   = payment.amount - newRefundedTotal;
        const isNowFullyRefunded    = refundableRemaining <= 0.01;
        const newRefundStatus       = isNowFullyRefunded ? 'refunded' : 'partial';

        const batch = db.batch();

        // Update refund doc → completed
        batch.update(refundRef, {
            status              : 'completed',
            refundedAmount      : requestedAmount,
            createRefundResponse,
            updatedAt           : new Date(),
        });

        // Update payment doc → summary fields
        batch.update(db.collection('payments').doc(internalPaymentId), {
            refundStatus              : newRefundStatus,
            refundedAmount            : newRefundedTotal,
            refundableAmountRemaining : Math.max(0, refundableRemaining),
            lastRefundAt              : new Date(),
            refundIds                 : [...(payment.refundIds || []), refundId],
            updatedAt                 : new Date(),
        });

        await batch.commit();

        logger.info(`✅ Firebase updated atomically — refundId: ${refundId} | newStatus: ${newRefundStatus} | totalRefunded: R${newRefundedTotal}`);

        // ── 12. Sync to External API ──────────────────────────────────────────
        // External API update is wrapped in its own try/catch.
        // A sync failure must NEVER affect the refund outcome.
        try {
            const statusLabel = isNowFullyRefunded
                ? 'Refund Completed'
                : 'Partial Refund Completed';

            // Refund completion timestamp in SA time (Africa/Johannesburg)
            const refundDateTime = new Date().toLocaleString('en-ZA', {
                timeZone     : 'Africa/Johannesburg',
                year         : 'numeric',
                month        : '2-digit',
                day          : '2-digit',
                hour         : '2-digit',
                minute       : '2-digit',
                hour12       : false,
            }); // e.g. "2026/05/01, 10:45"

            const notesLabel = isNowFullyRefunded
                ? `Full refund of R${requestedAmount.toFixed(2)} processed via PayFast. Refund ID: ${refundId}. Date & Time: ${refundDateTime}. Reason: ${reason.trim()}`
                : `Partial refund of R${requestedAmount.toFixed(2)} processed via PayFast. Remaining refundable: R${Math.max(0, refundableRemaining).toFixed(2)}. Refund ID: ${refundId}. Date & Time: ${refundDateTime}. Reason: ${reason.trim()}`;


            await syncRefundToExternalApi({
                restaurantId : payment.restaurantId,
                paymentId    : internalPaymentId,
                paymentStatus: statusLabel,
                paymentNotes : notesLabel,
            });

            await refundRef.update({ externalApiSynced: true, updatedAt: new Date() });
        } catch (syncErr) {
            logger.error(`❌ External API sync failed for refund ${refundId} (refund itself succeeded): ${syncErr.message}`);
            // Do NOT return error — refund completed successfully, sync is secondary
        }

        // ── 13. Return success response ───────────────────────────────────────
        return res.json({
            success           : true,
            refundId,
            paymentId         : internalPaymentId,
            refundedAmount    : requestedAmount,
            refundMethod,
            refundStatus      : newRefundStatus,   // 'refunded' | 'partial'
            totalRefunded     : newRefundedTotal,
            remainingRefundable: Math.max(0, refundableRemaining),
            message           : isNowFullyRefunded
                ? `Full refund of R${requestedAmount.toFixed(2)} processed successfully`
                : `Partial refund of R${requestedAmount.toFixed(2)} processed successfully`,
        });

    } catch (error) {
        logger.error(`❌ Refund Initiate unexpected error for ${paymentId}: ${error.message}`);
        logger.error(error.stack);
        return res.status(500).json({ success: false, error: 'Internal server error', message: error.message });
    }
});


// =============================================================================
// GET /api/refund/history/:paymentId
//
// Returns all refund records for a given payment.
// Frontend uses this to display refund history on the payment detail view.
// =============================================================================
router.get('/history/:paymentId', async (req, res) => {
    const { paymentId } = req.params;

    logger.info(`📋 Refund History request for paymentId: ${paymentId}`);

    try {
        const refundsSnapshot = await db.collection('refunds')
            .where('paymentId', '==', paymentId)
            .orderBy('createdAt', 'desc')
            .get();

        if (refundsSnapshot.empty) {
            return res.json({ success: true, paymentId, refunds: [], total: 0 });
        }

        const refunds = refundsSnapshot.docs.map((doc) => {
            const r = doc.data();
            return {
                refundId       : r.refundId,
                status         : r.status,
                refundType     : r.isFullRefund ? 'full' : 'partial',
                requestedAmount: r.requestedAmount,
                refundedAmount : r.refundedAmount || null,
                refundMethod   : r.refundMethod,
                reason         : r.reason,
                createdAt      : r.createdAt,
                updatedAt      : r.updatedAt,
            };
        });

        return res.json({
            success : true,
            paymentId,
            refunds,
            total   : refunds.length,
        });

    } catch (error) {
        logger.error(`❌ Refund History error for ${paymentId}: ${error.message}`);
        return res.status(500).json({ success: false, error: 'Internal server error', message: error.message });
    }
});

export default router;
