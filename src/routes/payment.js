import express from 'express';
import { db } from '../config/firebase.js';

const router = express.Router();

/**
 * GET /api/payment/:paymentId
 * Get booking details by payment ID for frontend payment page
 */
router.get('/:paymentId', async (req, res) => {
    try {
        const { paymentId } = req.params;

        console.log(`🔍 Fetching booking details for payment ID: ${paymentId}`);

        // Query Firestore for call log with this payment ID
        const callLogsRef = db.collection('callLogs');
        const snapshot = await callLogsRef.where('paymentId', '==', paymentId).limit(1).get();

        if (snapshot.empty) {
            console.warn(`⚠️ No booking found for payment ID: ${paymentId}`);
            return res.status(404).json({
                success: false,
                error: 'Booking not found',
                message: 'No booking exists with this payment ID'
            });
        }

        // Get the first (and only) document
        const doc = snapshot.docs[0];
        const callData = doc.data();

        // Check if booking data exists
        if (!callData.booking || !callData.booking.name) {
            return res.status(404).json({
                success: false,
                error: 'Incomplete booking data',
                message: 'Booking information is not available'
            });
        }

        // Return booking details
        const bookingDetails = {
            success: true,
            paymentId: callData.paymentId,
            callSid: callData.callSid,
            booking: {
                customerName: callData.booking.name,
                phoneNumber: callData.booking.phoneNo,
                numberOfGuests: callData.booking.guests,
                date: callData.booking.date,
                time: callData.booking.time,
                allergy: callData.booking.allergy,
                notes: callData.booking.notes,
            },
            restaurant: {
                id: callData.restaurantId,
                phone: callData.botPhone
            },
            callDetails: {
                startTime: callData.startTime,
                duration: callData.duration,
                status: callData.status
            },
            sms: {
                sent: callData.smsSent || false,
                sentAt: callData.smsDetails?.sentAt || null
            },
            createdAt: callData.createdAt,
            updatedAt: callData.updatedAt
        };

        console.log(`✅ Booking details found for ${callData.booking.name}`);
        res.json(bookingDetails);

    } catch (error) {
        console.error('❌ Error fetching booking by payment ID:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
});

export default router;
