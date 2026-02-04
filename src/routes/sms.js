import express from 'express';
import { db } from '../config/firebase.js';
import smsService from '../services/smsService.js';

const router = express.Router();

/**
 * POST /api/sms/send
 * Manually send SMS for a specific call
 */
router.post('/send', async (req, res) => {
    try {
        const { callSid } = req.body;

        if (!callSid) {
            return res.status(400).json({
                success: false,
                error: 'Missing callSid in request body'
            });
        }

        // Get call log from Firestore
        const callLogRef = db.collection('callLogs').doc(callSid);
        const callLogDoc = await callLogRef.get();

        if (!callLogDoc.exists) {
            return res.status(404).json({
                success: false,
                error: `Call log not found for SID: ${callSid}`
            });
        }

        const callData = callLogDoc.data();

        // Validate booking data
        if (!callData.booking || !callData.booking.name || !callData.booking.phoneNo) {
            return res.status(400).json({
                success: false,
                error: 'Incomplete booking data - cannot send SMS',
                booking: callData.booking
            });
        }

        // Send SMS
        console.log(`📱 Manual SMS request for ${callSid}...`);
        const smsResult = await smsService.sendAutomatedSms(
            callData.booking,
            callData.paymentId
        );

        // Update Firestore
        await callLogRef.update({
            smsSent: smsResult.success,
            smsDetails: {
                sid: smsResult.sid || null,
                sentAt: smsResult.sentAt,
                status: smsResult.status || null,
                error: smsResult.error || null
            },
            updatedAt: new Date()
        });

        res.json({
            success: smsResult.success,
            message: smsResult.success ? 'SMS sent successfully' : 'SMS sending failed',
            callSid,
            paymentId: callData.paymentId,
            smsDetails: smsResult
        });

    } catch (error) {
        console.error('❌ SMS API error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/sms/status/:callSid
 * Get SMS status for a call
 */
router.get('/status/:callSid', async (req, res) => {
    try {
        const { callSid } = req.params;

        const callLogDoc = await db.collection('callLogs').doc(callSid).get();

        if (!callLogDoc.exists) {
            return res.status(404).json({
                success: false,
                error: `Call log not found for SID: ${callSid}`
            });
        }

        const data = callLogDoc.data();

        res.json({
            success: true,
            callSid,
            paymentId: data.paymentId,
            smsSent: data.smsSent || false,
            smsDetails: data.smsDetails || null,
            booking: data.booking
        });

    } catch (error) {
        console.error('❌ SMS status API error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

export default router;
