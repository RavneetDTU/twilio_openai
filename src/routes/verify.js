import express from 'express';
import Twilio from 'twilio';

const router = express.Router();

const twilioClient = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

/**
 * POST /api/verify/phone
 * Verify a phone number using Twilio Lookup API v2
 * Body: { phoneNumber: "+1234567890" }
 */
router.post('/phone', async (req, res) => {
    try {
        const { phoneNumber } = req.body;

        if (!phoneNumber) {
            return res.status(400).json({ success: false, error: 'phoneNumber is required' });
        }

        const result = await twilioClient.lookups.v2
            .phoneNumbers(phoneNumber)
            .fetch({ fields: 'line_type_intelligence' });

        console.log('📞 Verify result:', result);

        res.json({
            success: true,
            valid: result.valid,
            phoneNumber: result.phoneNumber,
            nationalFormat: result.nationalFormat,
            carrier: result.lineTypeIntelligence?.carrierName || 'Unknown',
            type: result.lineTypeIntelligence?.type || 'Unknown'
        });

    } catch (error) {
        if (error.status === 404) {
            return res.status(400).json({ success: false, valid: false, error: 'Invalid phone number' });
        }
        console.error('❌ Phone verification error:', error);
        res.status(500).json({ success: false, error: 'Verification failed' });
    }
});

export default router;
