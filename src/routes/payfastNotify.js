import express from 'express';
import { db } from '../config/firebase.js';
import logger from '../utils/logger.js';
import {
    validateSignature,
    validatePayfastDomain,
    confirmWithPayfast,
    validateAmount
} from '../services/payfastService.js';

const router = express.Router();

/**
 * POST /api/payfast/notify
 * 
 * Payfast ITN (Instant Transaction Notification) endpoint.
 * This is the notify_url that Payfast calls server-to-server
 * after a payment is processed.
 * 
 * Payfast sends a POST with fields including:
 * - m_payment_id: Your custom payment ID (our paymentId from callLogs)
 * - pf_payment_id: Payfast's own transaction ID
 * - payment_status: COMPLETE / FAILED / PENDING
 * - amount_gross: Total amount charged
 * - amount_fee: Payfast fee
 * - amount_net: Net amount after fees
 * - name_first, name_last, email_address: Customer details
 * - merchant_id: Your merchant ID
 * - signature: MD5 signature for verification
 */
router.post('/notify', async (req, res) => {
    logger.info('📨 Payfast ITN: Notification received');
    logger.info(`📦 Payfast ITN Body: ${JSON.stringify(req.body, null, 2)}`);

    // Step 1: Immediately respond 200 OK (Payfast requires this to avoid retries)
    res.status(200).send('OK');

    try {
        const payfastData = req.body;
        const passphrase = process.env.PAYFAST_PASSPHRASE || null;

        // Step 2: Validate Payfast domain via DNS lookup
        const isDomainValid = await validatePayfastDomain(req);
        if (!isDomainValid) {
            logger.error('❌ Payfast ITN: Rejected — request not from a valid Payfast domain');
            return;
        }

        // Step 3: Validate signature
        if (!validateSignature(payfastData, passphrase)) {
            logger.error('❌ Payfast ITN: Rejected — invalid signature');
            return;
        }

        // Step 4: Server-to-server confirmation with Payfast
        const isConfirmed = await confirmWithPayfast(payfastData);
        if (!isConfirmed) {
            logger.error('❌ Payfast ITN: Rejected — server confirmation failed');
            return;
        }

        // Step 5: Extract the paymentId (m_payment_id is our UUID from callLogs)
        const paymentId = payfastData.m_payment_id;
        if (!paymentId) {
            logger.error('❌ Payfast ITN: No m_payment_id in request');
            return;
        }

        // Step 6: Check idempotency — skip if already processed
        const existingPayment = await db.collection('payments')
            .where('paymentId', '==', paymentId)
            .where('status', '==', 'success')
            .limit(1)
            .get();

        if (!existingPayment.empty) {
            logger.info(`ℹ️ Payfast ITN: Payment ${paymentId} already processed — skipping`);
            return;
        }

        // Step 7: Look up the booking from callLogs using paymentId
        const callLogsSnapshot = await db.collection('callLogs')
            .where('paymentId', '==', paymentId)
            .limit(1)
            .get();

        if (callLogsSnapshot.empty) {
            logger.error(`❌ Payfast ITN: No booking found for paymentId: ${paymentId}`);
            return;
        }

        const callLogDoc = callLogsSnapshot.docs[0];
        const callData = callLogDoc.data();

        // Step 8: Validate amount matches the booking amount
        const expectedAmount = callData.booking?.bookingAmount || 0;
        if (!validateAmount(payfastData.amount_gross, expectedAmount)) {
            logger.error('❌ Payfast ITN: Rejected — amount mismatch');
            return;
        }

        // Step 9: Determine payment status
        const paymentStatus = payfastData.payment_status === 'COMPLETE' ? 'success' : 'failed';

        // Step 10: Write to payments collection
        const paymentDoc = {
            paymentId: paymentId,
            callSid: callData.callSid,
            restaurantId: callData.restaurantId,
            restaurantName: callData.restaurantName || null,
            customerName: callData.booking?.name || null,
            customerPhone: callData.booking?.phoneNo || null,
            amount: parseFloat(payfastData.amount_gross) || 0,
            amountFee: parseFloat(payfastData.amount_fee) || 0,
            amountNet: parseFloat(payfastData.amount_net) || 0,
            guests: callData.booking?.guests || null,
            bookingDate: callData.booking?.date || null,
            bookingTime: callData.booking?.time || null,
            gatewayTransactionId: payfastData.pf_payment_id || null,
            gatewayStatus: payfastData.payment_status || null,
            gatewayPaymentMethod: payfastData.payment_method || null,
            gatewayRawResponse: payfastData,
            status: paymentStatus,
            paidAt: paymentStatus === 'success' ? new Date() : null,
            createdAt: new Date(),
            updatedAt: new Date()
        };

        await db.collection('payments').doc(paymentId).set(paymentDoc);
        logger.info(`✅ Payfast ITN: Payment saved — ${paymentId} (Status: ${paymentStatus})`);

        // Step 11: Update the callLogs document with payment status
        await callLogDoc.ref.update({
            paymentStatus: paymentStatus,
            paymentCompletedAt: paymentStatus === 'success' ? new Date() : null,
            updatedAt: new Date()
        });
        logger.info(`✅ Payfast ITN: CallLog updated for ${callData.callSid} — paymentStatus: ${paymentStatus}`);

    } catch (error) {
        logger.error(`❌ Payfast ITN: Processing error: ${error.message}`);
        logger.error(error.stack);
    }
});


/**
 * GET /api/payfast/payments/:restaurantId
 * 
 * Fetch all payments for a specific restaurant.
 * Returns payments ordered by creation date (newest first).
 */
router.get('/payments/:restaurantId', async (req, res) => {
    try {
        const { restaurantId } = req.params;

        logger.info(`🔍 Fetching payments for restaurant: ${restaurantId}`);

        const paymentsSnapshot = await db.collection('payments')
            .where('restaurantId', '==', restaurantId)
            .orderBy('createdAt', 'desc')
            .get();

        if (paymentsSnapshot.empty) {
            return res.json({
                success: true,
                restaurantId,
                payments: [],
                total: 0,
                message: 'No payments found for this restaurant'
            });
        }

        const payments = [];
        let totalAmount = 0;

        paymentsSnapshot.forEach(doc => {
            const payment = doc.data();
            payments.push({
                paymentId: payment.paymentId,
                callSid: payment.callSid,
                customerName: payment.customerName,
                customerPhone: payment.customerPhone,
                amount: payment.amount,
                amountFee: payment.amountFee,
                amountNet: payment.amountNet,
                guests: payment.guests,
                bookingDate: payment.bookingDate,
                bookingTime: payment.bookingTime,
                gatewayTransactionId: payment.gatewayTransactionId,
                status: payment.status,
                paidAt: payment.paidAt,
                createdAt: payment.createdAt
            });

            if (payment.status === 'success') {
                totalAmount += payment.amount || 0;
            }
        });

        res.json({
            success: true,
            restaurantId,
            payments,
            total: payments.length,
            totalAmount: parseFloat(totalAmount.toFixed(2))
        });

    } catch (error) {
        logger.error(`❌ Error fetching payments: ${error.message}`);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
});

export default router;
