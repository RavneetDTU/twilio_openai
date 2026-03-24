import { v4 as uuidv4 } from 'uuid';
import { db } from '../config/firebase.js';
import smsService from './smsService.js';
import { getRestaurantDetails } from '../utils/config.js';

class ManualBookingService {
    /**
     * Creates a manual booking, saves it to Firestore, and sends an SMS payment link.
     * @param {string} restaurantId 
     * @param {Object} bookingData - Contains name, phoneNo, guests, date, time, allergy, notes
     * @returns {Promise<Object>} Response object containing success, paymentId, and SMS details
     */
    async createManualBooking(restaurantId, bookingData) {
        const { name, phoneNo, guests, date, time, allergy, notes } = bookingData;

        if (!name || !phoneNo || !guests) {
            throw new Error('Missing required booking fields: name, phoneNo, or guests');
        }

        // 1. Get deposit amount from restaurant config
        let depositAmount = 0;
        let restaurantName = "Billy's Steakhouse"; // default fallback
        
        try {
            const details = await getRestaurantDetails(restaurantId);
            if (details) {
                depositAmount = Number(details.depositAmount || details.settings?.depositAmount) || 0;
                restaurantName = details.name || restaurantName;
            }
        } catch (configErr) {
            console.warn(`⚠️ Could not fetch restaurant details for ID: ${restaurantId}. Proceeding with default deposit of 0.`);
        }

        // Calculate total booking amount
        const bookingAmount = Number(guests) * depositAmount;

        // 2. Generate Payment UUID
        const paymentId = uuidv4();

        // 3. Prepare manual booking data
        const manualBookingData = {
            paymentId,
            restaurantId,
            name,
            phoneNo,
            guests: Number(guests),
            date: date || null,
            time: time || null,
            allergy: allergy || "NA",
            notes: notes || "NA",
            depositAmount,
            bookingAmount,
            smsStatus: 'Pending',
            createdAt: new Date()
        };

        // 4. Save to DB first
        const docRef = db.collection('manualBookings').doc(paymentId);
        console.log("Manual booking created successfully", manualBookingData);
        await docRef.set(manualBookingData);

        // 5. Send SMS using existing service
        console.log(`📱 Sending manual booking SMS for payment ID: ${paymentId}...`);
        
        const bookingDataForSms = { ...manualBookingData };
        const smsResult = await smsService.sendAutomatedSms(
            bookingDataForSms,
            paymentId,
            restaurantName
        );

        // 6. Update DB with SMS result
        const smsStatus = smsResult.success ? 'Success' : 'Failed';
        await docRef.update({
            smsStatus,
            smsDetails: {
                sid: smsResult.sid || null,
                sentAt: smsResult.sentAt || null,
                error: smsResult.error || null
            }
        });

        // 7. Return Result
        return {
            success: true,
            message: smsResult.success ? 'Booking saved and SMS sent' : 'Booking saved but SMS failed',
            paymentId,
            smsStatus,
            smsDetails: smsResult
        };
    }
}

export default new ManualBookingService();
