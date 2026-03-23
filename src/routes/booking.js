import express from 'express';
import manualBookingService from '../services/manualBookingService.js';

const router = express.Router();

/**
 * POST /api/booking/manual/:restaurantId
 * Create a manual booking and send an SMS with the payment link
 */
router.post('/manual/:restaurantId', async (req, res) => {
    try {
        const { restaurantId } = req.params;
        
        // Delegate all heavy lifting (DB, SMS, formatting) to the service layer
        const result = await manualBookingService.createManualBooking(restaurantId, req.body);
        
        res.json(result);
    } catch (error) {
        console.error('❌ Manual booking API error:', error);
        res.status(error.message.includes('Missing required booking fields') ? 400 : 500).json({
            success: false,
            error: error.message
        });
    }
});

export default router;
