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

        let callData = null;

        // Query Firestore for call log with this payment ID
        const callLogsRef = db.collection('callLogs');
        const snapshot = await callLogsRef.where('paymentId', '==', paymentId).limit(1).get();

        if (!snapshot.empty) {
            // Get the first (and only) document
            const doc = snapshot.docs[0];
            callData = doc.data();
        } else {
            // Check manualBookings if not found in callLogs
            const manualRef = db.collection('manualBookings');
            const manualSnapshot = await manualRef.where('paymentId', '==', paymentId).limit(1).get();
            
            if (!manualSnapshot.empty) {
                const manualDoc = manualSnapshot.docs[0];
                const manual = manualDoc.data();
                
                // Map to the format expected by the frontend
                callData = {
                    paymentId: manual.paymentId,
                    callSid: null,
                    restaurantId: manual.restaurantId,
                    botPhone: null,
                    booking: {
                        name: manual.name,
                        phoneNo: manual.phoneNo,
                        guests: manual.guests,
                        date: manual.date,
                        time: manual.time,
                        allergy: manual.allergy,
                        notes: manual.notes,
                        bookingAmount: manual.bookingAmount || 0
                    },
                    startTime: manual.createdAt,
                    duration: 0,
                    status: 'completed',
                    smsSent: manual.smsStatus === 'Success',
                    smsDetails: { sentAt: manual.createdAt },
                    createdAt: manual.createdAt,
                    updatedAt: manual.createdAt
                };
            }
        }

        if (!callData) {
            console.warn(`⚠️ No booking found for payment ID: ${paymentId}`);
            return res.status(404).json({
                success: false,
                error: 'Booking not found',
                message: 'No booking exists with this payment ID'
            });
        }

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
                bookingAmount: callData.booking.bookingAmount || 0,
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
