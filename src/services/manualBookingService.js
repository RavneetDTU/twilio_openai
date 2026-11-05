import { v4 as uuidv4 } from 'uuid';
import { db } from '../config/firebase.js';
import smsService from './smsService.js';
import { sendBookingNotificationEmail } from './emailService.js';
import { getRestaurantDetails } from '../utils/config.js';
import { isSheetImportedRestaurantId } from './sheetRestaurantIds.js';
import logger from '../utils/logger.js';

const RESERVATION_API_BASE = 'https://mybookiapis.booki.co.za/restaurants';

class ManualBookingService {
    /**
     * Creates a manual booking, saves it to Firestore, and sends an SMS payment link.
     * @param {string} restaurantId 
     * @param {Object} bookingData - Contains name, phoneNo, guests, date, time, allergy, notes
     * @param {Object} [options] - Optional, used by the WhatsApp channel. Omitted = unchanged behaviour.
     * @param {string} [options.source] - Sent to the reservation API as `source`
     * @param {number|string} [options.sittingId] - Sent to the reservation API as `sitting_id`
     * @param {boolean} [options.skipSms] - Do not send the SMS payment link (smsStatus 'Skipped')
     * @param {Object} [options.extraFields] - Extra fields saved on the manualBookings doc
     * @returns {Promise<Object>} Response object containing success, paymentId, and SMS details
     */
    async createManualBooking(restaurantId, bookingData, options = {}) {
        const { name, phoneNo, guests, date, time, allergy, notes } = bookingData;

        if (!name || !phoneNo || !guests) {
            throw new Error('Missing required booking fields: name, phoneNo, or guests');
        }

        // 1. Get deposit amount from restaurant config
        let depositAmount = 0;
        let restaurantName = "Billy's Steakhouse"; // default fallback
        let restaurantNotificationEmail = null;
        
        try {
            const details = await getRestaurantDetails(restaurantId);
            if (details) {
                depositAmount = Number(details.depositAmount || details.settings?.depositAmount) || 0;
                restaurantName = details.name || restaurantName;
                restaurantNotificationEmail =
                    details.RestaurantEmail ||
                    details.notificationEmail ||
                    details.email ||
                    details.settings?.RestaurantEmail ||
                    details.settings?.notificationEmail ||
                    details.settings?.email ||
                    null;
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
            paymentStatus: 'Pending',
            smsStatus: 'Pending',
            createdAt: new Date(),
            ...(options.extraFields || {})
        };

        // 4. Save to DB first
        const docRef = db.collection('manualBookings').doc(paymentId);
        logger.info("Manual booking created successfully", manualBookingData);
        await docRef.set(manualBookingData);

        // 4.5. Send to External Reservation API (Mybooki restaurants only)
        if (isSheetImportedRestaurantId(restaurantId)) {
            logger.info(`📡 Skipping Mybooki reservation API for directory restaurant ${restaurantId}`);
            await docRef.update({ reservationApiStatus: 'skipped_directory_restaurant' });
        } else {
            try {
                const url = `${RESERVATION_API_BASE}/${restaurantId}/reservations`;
                const payload = {
                    reference_id: paymentId || null,
                    name: name || null,
                    phone: phoneNo || null,
                    date: date || null,
                    time: time || null,
                    party_size: Number(guests) || 0,
                    allergies: allergy || 'N/A',
                    notes: notes || 'N/A',
                    transcription: 'Manually Created', // Manual booking has no transcription
                    ...(options.source ? { source: options.source } : {}),
                    ...(options.sittingId != null ? { sitting_id: options.sittingId } : {})
                };

                logger.info(`📡 Sending manual reservation to API: ${url}`);
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    logger.error(`❌ Reservation API error (${response.status}): ${errorText}`);
                } else {
                    logger.info(`✅ Manual Reservation API success`);
                }
            } catch (apiError) {
                logger.error(`❌ Manual Reservation API request failed: ${apiError.message}`);
            }
        }

        // 5. Send SMS using existing service
        logger.info(`📱 Sending manual booking SMS for payment ID: ${paymentId}...`);
        
        const bookingDataForSms = { ...manualBookingData };
        const smsResult = options.skipSms
            ? { success: false, skipped: true, error: 'Skipped: payment link sent on WhatsApp' }
            : await smsService.sendAutomatedSms(
                bookingDataForSms,
                paymentId,
                restaurantName
            );

        // 6. Update DB with SMS result
        const smsStatus = smsResult.skipped ? 'Skipped' : (smsResult.success ? 'Success' : 'Failed');
        await docRef.update({
            smsStatus,
            smsDetails: {
                sid: smsResult.sid || null,
                sentAt: smsResult.sentAt || null,
                error: smsResult.error || null
            }
        });

        // 6.5 Send restaurant booking notification email
        logger.info(`📧 Sending booking notification email for payment ID: ${paymentId}...`);
        const emailResult = await sendBookingNotificationEmail({
            toEmail: restaurantNotificationEmail,
            restaurantName,
            customerName: name,
            customerPhone: phoneNo,
            guests: Number(guests),
            bookingDate: date || null,
            bookingTime: time || null,
            paymentId,
            bookingAmount
        });

        await docRef.update({
            emailStatus: emailResult.success ? 'Success' : 'Failed',
            emailDetails: {
                to: restaurantNotificationEmail,
                messageId: emailResult.messageId || null,
                accepted: emailResult.accepted || [],
                response: emailResult.response || null,
                sentAt: emailResult.sentAt || null,
                error: emailResult.error || null
            }
        });

        // 7. Return Result
        return {
            success: true,
            message: smsResult.success
                ? 'Booking saved and SMS sent'
                : 'Booking saved but SMS failed',
            paymentId,
            smsStatus,
            smsDetails: smsResult,
            emailStatus: emailResult.success ? 'Success' : 'Failed',
            emailDetails: emailResult
        };
    }
}

export default new ManualBookingService();
