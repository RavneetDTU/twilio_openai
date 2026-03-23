import Twilio from 'twilio';
import logger from '../utils/logger.js';
import dotenv from 'dotenv';

dotenv.config();

class SmsService {
    constructor() {
        this.client = new Twilio(
            process.env.TWILIO_ACCOUNT_SID,
            process.env.TWILIO_AUTH_TOKEN
        );
        this.fromNumber = process.env.TWILIO_PHONE_NUMBER;
        this.paymentBaseUrl = process.env.PAYMENT_FRONTEND_URL || 'https://mybookip.vercel.app';
    }

    /**
     * Format phone number to E.164 format (+[country code][number])
     * @param {string} phoneNumber - Phone number in any format
     * @param {string} defaultCountryCode - Default country code (e.g., '91' for India, '1' for US)
     * @returns {string} Formatted phone number
     */
    formatPhoneNumber(phoneNumber, defaultCountryCode = '27') {
        if (!phoneNumber) return null;

        // If the number explicitly starts with a + sign, it already has a country code.
        // We just need to clean out any spaces/dashes and keep the +.
        if (phoneNumber.trim().startsWith('+')) {
            const exactCleaned = phoneNumber.replace(/\D/g, '');
            return `+${exactCleaned}`;
        }

        // Remove all non-digit characters
        let cleaned = phoneNumber.replace(/\D/g, '');

        if (cleaned == "8319377879" || cleaned == "8930276263") {
            defaultCountryCode = "91";
        } else {
            defaultCountryCode = "27";
        }

        // If already starts with country code, add + and return
        if (cleaned.startsWith(defaultCountryCode) && cleaned.length > defaultCountryCode.length) {
            return `+${cleaned}`;
        }

        // If starts with 0, remove it (common in Indian numbers: 083... -> 83...)
        if (cleaned.startsWith('0')) {
            cleaned = cleaned.substring(1);
        }

        // Add country code
        return `+${defaultCountryCode}${cleaned}`;
    }

    /**
     * Converts a time string (e.g., "19:00", "07:00") to 12-hour AM/PM format.
     */
    formatTo12Hour(timeStr) {
        if (!timeStr) return null;
        const cleanedStr = timeStr.trim().toLowerCase();
        
        // If it already contains AM/PM, return as is (capitalized properly)
        if (cleanedStr.includes('am') || cleanedStr.includes('pm')) {
            return timeStr.toUpperCase();
        }

        const parts = timeStr.split(':');
        if (parts.length >= 2) {
            let hours = parseInt(parts[0], 10);
            let minutes = parseInt(parts[1], 10);
            
            if (!isNaN(hours) && !isNaN(minutes)) {
                const ampm = hours >= 12 ? 'PM' : 'AM';
                hours = hours % 12;
                hours = hours ? hours : 12; // the hour '0' should be '12'
                const minutesStr = minutes < 10 ? '0' + minutes : minutes;
                return `${hours}:${minutesStr} ${ampm}`;
            }
        }
        
        return timeStr; // Fallback if parsing fails
    }

    /**
     * Send SMS with payment link
     * @param {Object} params
     * @param {string} params.customerName
     * @param {string} params.customerPhone
     * @param {number} params.numberOfGuests
     * @param {string} params.bookingDate
     * @param {string} params.bookingTime
     * @param {string} params.paymentId
     * @param {string} params.restaurantName
     */
    async sendPaymentSms({
        customerName,
        customerPhone,
        numberOfGuests,
        bookingDate,
        bookingTime,
        paymentId,
        restaurantName = 'Our Restaurant',
        bookingAmount = 0
    }) {
        try {
            if (!this.fromNumber) {
                throw new Error('TWILIO_PHONE_NUMBER not configured in .env file');
            }

            // Format phone number to E.164 format
            const formattedPhone = this.formatPhoneNumber(customerPhone);

            if (!formattedPhone) {
                throw new Error('Invalid phone number provided');
            }

            logger.info(`📱 Formatted phone: ${customerPhone} -> ${formattedPhone}`);

            const formattedTime = this.formatTo12Hour(bookingTime);

            let message = `Dear ${customerName},\n\nThank you for your reservation! We've reserved a table for ${numberOfGuests} ${numberOfGuests === 1 ? 'person' : 'people'} at ${restaurantName}${bookingDate ? ` on ${bookingDate}` : ''}${formattedTime ? ` at ${formattedTime}` : ''}.\n\n`;

            if (bookingAmount > 0) {
                const paymentLink = `${this.paymentBaseUrl}/payment/${paymentId}`;
                message += `Please secure your booking by completing payment here:\n${paymentLink}\n\n`;
            }

            message += `We look forward to serving you!\n\nBest regards,\n${restaurantName}`;

            logger.info(`📱 Sending SMS to ${formattedPhone}...`);

            const smsResponse = await this.client.messages.create({
                body: message,
                from: this.fromNumber,
                to: formattedPhone,
            });

            logger.info(`✅ SMS sent successfully! SID: ${smsResponse.sid}`);

            return {
                success: true,
                sid: smsResponse.sid,
                status: smsResponse.status,
                sentAt: new Date()
            };

        } catch (error) {
            logger.error(`❌ SMS sending failed: ${error.message}`);
            return {
                success: false,
                error: error.message,
                sentAt: new Date()
            };
        }
    }

    /**
     * Send automated SMS after call completion
     * @param {Object} bookingData - Extracted booking data from call
     * @param {string} paymentId - UUID payment identifier
     */
    async sendAutomatedSms(bookingData, paymentId, restaurantName = "Billy's Steakhouse") {
        const { name, phoneNo, guests, date, time, bookingAmount } = bookingData;

        if (!name || !phoneNo || !guests) {
            logger.warn('⚠️ Missing required booking data for SMS');
            return {
                success: false,
                error: 'Missing required booking data (name, phone, or guests)'
            };
        }

        return this.sendPaymentSms({
            customerName: name,
            customerPhone: phoneNo,
            numberOfGuests: guests,
            bookingDate: date || null,
            bookingTime: time || null,
            paymentId,
            restaurantName,
            bookingAmount: bookingAmount || 0
        });
    }
}

export default new SmsService();
