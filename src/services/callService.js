import { db } from '../config/firebase.js';
import logger from '../utils/logger.js';
import { downloadFile } from '../utils/download.js';
import { transcribeAudio } from '../utils/transcription.js';
import { extractBookingData } from '../utils/extraction.js';
import { v4 as uuidv4 } from 'uuid';
import smsService from './smsService.js';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.resolve(__dirname, '../prompts/prompts.json');

const RESERVATION_API_BASE = 'https://mybookiapis.jarviscalling.ai/restaurants';

/**
 * Single map: caller phone → { id, name }
 * Any unknown number defaults to Billy's Steakhouse.
 */
const RESTAURANT_MAP = {
    '+27844500010': { id: '2', name: "Ryan's Steakhouse" },
    '+27765575522': { id: '3', name: "Bjorn's Steakhouse" },
    '+918930276263': { id: '1', name: "Billy's Steakhouse" },
    '+918319377879': { id: '1', name: "Billy's Steakhouse" },
    '+27210073477': { id: '4', name: "Wine Tasting Terrance" },
};

const DEFAULT_RESTAURANT = { id: '1', name: "Billy's Steakhouse" };

const getRestaurantInfo = (callerPhone) => {
    const info = RESTAURANT_MAP[callerPhone] || DEFAULT_RESTAURANT;
    logger.info(`🏪 Restaurant resolved: ${info.name} (ID: ${info.id}) for caller: ${callerPhone}`);
    return info;
};

/**
 * Creates a new CallLog document when a call starts.
 * @param {Object} params
 * @param {string} params.callSid
 * @param {string} params.from - Customer Phone
 * @param {string} params.to - Bot Phone
 */
export const createCallLog = async ({ callSid, from, to }) => {
    logger.info(`📝 Creating CallLog for SID: ${callSid}`);

    try {
        const { id: restaurantId, name: restaurantName } = getRestaurantInfo(from);
        const paymentId = uuidv4();

        const callLogData = {
            callSid,
            customerPhone: from,
            botPhone: to,
            restaurantId,
            restaurantName,
            paymentId,
            status: 'active',
            bookingStatus: 'pending',
            startTime: new Date(),
            recordingUrl: null,
            localFilePath: null,
            transcription: null,
            booking: {
                name: null,
                date: null,
                time: null,
                guests: null,
                phoneNo: null,
                allergy: null,
                notes: null,
                bookingAmount: 0
            },
            duration: 0,
            smsSent: false,
            smsDetails: {
                sid: null,
                sentAt: null,
                status: null,
                error: null
            },
            createdAt: new Date(),
            updatedAt: new Date()
        };

        await db.collection('callLogs').doc(callSid).set(callLogData);

        logger.info(`✅ CallLog Created: ${callSid} (Restaurant: ${restaurantName} [${restaurantId}], Payment ID: ${paymentId})`);
        return callLogData;
    } catch (error) {
        logger.error(`❌ Error creating CallLog for ${callSid}: ${error.message}`);
        throw error;
    }
};

/**
 * Classifies a booking as 'complete' or 'failed' based on critical fields.
 * Complete = has name + phone + date (all 3 required)
 * Failed = missing any of the 3 critical fields
 * @param {Object|null} bookingData 
 * @returns {'complete'|'failed'}
 */
const classifyBooking = (bookingData) => {
    if (!bookingData) return 'failed';

    const hasName = bookingData.name && bookingData.name.trim() !== '';
    const hasPhone = bookingData.phoneNo && bookingData.phoneNo.trim() !== '';
    const hasDate = bookingData.date && bookingData.date.trim() !== '';

    if (hasName && hasPhone && hasDate) {
        return 'complete';
    }
    return 'failed';
};

/**
 * Posts the booking to the external reservation API.
 * @param {string} restaurantId 
 * @param {Object} bookingData 
 * @param {string} transcriptText 
 */
const sendReservationToApi = async (restaurantId, bookingData, transcriptText) => {
    const url = `${RESERVATION_API_BASE}/${restaurantId}/reservations`;

    const payload = {
        name: bookingData.name || null,
        phone: bookingData.phoneNo || null,
        date: bookingData.date || null,
        time: bookingData.time || null,
        party_size: bookingData.guests || 0,
        allergies: bookingData.allergy || null,
        notes: bookingData.notes || null,
        transcription: transcriptText || null
    };

    logger.info(`📡 Sending reservation to API: ${url}`);
    logger.info(`📦 Payload: ${JSON.stringify(payload, null, 2)}`);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            logger.error(`❌ Reservation API error (${response.status}): ${errorText}`);
            return { success: false, status: response.status, error: errorText };
        }

        const result = await response.json();
        logger.info(`✅ Reservation API success: ${JSON.stringify(result, null, 2)}`);
        return { success: true, data: result };

    } catch (apiError) {
        logger.error(`❌ Reservation API request failed: ${apiError.message}`);
        return { success: false, error: apiError.message };
    }
};

/**
 * Posts failed/incomplete booking to the failed-bookings API.
 * Missing fields are sent as "Not Provided".
 * @param {string} restaurantId 
 * @param {Object|null} bookingData 
 * @param {string} transcriptText 
 */
const sendFailedBookingToApi = async (restaurantId, bookingData, transcriptText) => {
    const url = `${RESERVATION_API_BASE}/${restaurantId}/failed-bookings`;

    // Get current date/time in Africa/Johannesburg timezone for call_date and call_time
    const now = new Date();
    const callDate = now.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' }); // "YYYY-MM-DD"
    const callTime = now.toLocaleTimeString('en-GB', { timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit', hour12: false }); // "HH:mm"

    const payload = {
        call_date: callDate,
        call_time: callTime,
        guest_name: bookingData?.name || 'Not Provided',
        phone: bookingData?.phoneNo || 'Not Provided',
        date: bookingData?.date || 'Not Provided',
        time: bookingData?.time || 'Not Provided',
        party_size: bookingData?.guests || 0,
        allergies: bookingData?.allergy || 'Not Provided',
        notes: bookingData?.notes || 'Not Provided',
        transcription: transcriptText || 'Not Provided'
    };

    logger.info(`📡 Sending failed booking to API: ${url}`);
    logger.info(`📦 Failed Booking Payload: ${JSON.stringify(payload, null, 2)}`);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            logger.error(`❌ Failed Booking API error (${response.status}): ${errorText}`);
            return { success: false, status: response.status, error: errorText };
        }

        const result = await response.json();
        logger.info(`✅ Failed Booking API success: ${JSON.stringify(result, null, 2)}`);
        return { success: true, data: result };

    } catch (apiError) {
        logger.error(`❌ Failed Booking API request failed: ${apiError.message}`);
        return { success: false, error: apiError.message };
    }
};

/**
 * Updates the CallLog with recording details when the call completes.
 * @param {Object} params
 * @param {string} params.callSid
 * @param {string} params.recordingUrl
 * @param {number} params.duration
 */
export const updateCallLog = async ({ callSid, recordingUrl, duration }) => {
    logger.info(`📝 Updating CallLog for SID: ${callSid}`);

    try {
        if (!callSid) throw new Error("Missing CallSid");

        const fileName = `${callSid}.mp3`;
        const localPath = path.resolve('recordings', fileName);

        let savedPath = null;
        let transcriptText = null;
        let bookingData = null;

        try {
            await downloadFile(recordingUrl, localPath);
            savedPath = localPath;

            // Transcribe immediately after download
            transcriptText = await transcribeAudio(localPath);

            // Extract structured Booking Data
            if (transcriptText) {
                bookingData = await extractBookingData(transcriptText);
            }

        } catch (processErr) {
            logger.error(`❌ Failed processing (download/transcribe/extract) for ${callSid}: ${processErr.message}`);
        }

        // Get reference to the document
        const callLogRef = db.collection('callLogs').doc(callSid);
        const callLogDoc = await callLogRef.get();

        if (!callLogDoc.exists) {
            logger.warn(`⚠️ Warning: No active CallLog found for SID: ${callSid}`);
            return null;
        }

        const existingData = callLogDoc.data();
        logger.info(`🏪 Booking Restaurant: ${existingData.restaurantName} (ID: ${existingData.restaurantId})`);

        // Load prompts.json to get deposit amount
        let depositAmount = 0;
        try {
            const fileData = await fs.readFile(CONFIG_PATH, 'utf-8');
            const data = JSON.parse(fileData);
            const restaurantConfig = data.restaurants.find(r => r.restaurantId === existingData.restaurantId);
            if (restaurantConfig && restaurantConfig.settings && restaurantConfig.settings.depositAmount) {
                depositAmount = Number(restaurantConfig.settings.depositAmount) || 0;
            }
        } catch (configErr) {
            logger.error(`❌ Failed to read deposit amount for ${callSid}: ${configErr.message}`);
        }

        // Calculate total booking amount
        let bookingAmount = 0;
        if (bookingData && bookingData.guests) {
            bookingAmount = Number(bookingData.guests) * depositAmount;
        }

        // Classify the booking: 'complete' (has name+phone+date) or 'failed'
        const bookingStatus = classifyBooking(bookingData);
        logger.info(`📊 Booking classified as: ${bookingStatus} for ${callSid}`);

        // Update the document
        const updateData = {
            recordingUrl,
            localFilePath: savedPath,
            transcription: transcriptText,
            booking: bookingData ? { ...bookingData, bookingAmount } : {
                name: null,
                date: null,
                time: null,
                guests: null,
                phoneNo: null,
                allergy: null,
                notes: null,
                bookingAmount: 0
            },
            duration,
            status: 'completed',
            bookingStatus,
            updatedAt: new Date()
        };

        await callLogRef.update(updateData);
        logger.info(`✅ CallLog Updated: ${callSid} -> URL: ${recordingUrl}`);

        // Route to the correct API based on booking classification
        if (bookingStatus === 'complete') {
            // COMPLETE: Send to existing reservation API
            logger.info(`✅ Complete booking detected for ${callSid} — sending to Reservation API`);
            await sendReservationToApi(existingData.restaurantId, bookingData, transcriptText);

            // Send automated SMS for complete bookings
            logger.info(`📱 Attempting to send automated SMS for ${callSid}...`);
            try {
                const bookingDataForSms = { ...bookingData, bookingAmount };

                const smsResult = await smsService.sendAutomatedSms(
                    bookingDataForSms,
                    existingData.paymentId,
                    existingData.restaurantName
                );

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

                if (smsResult.success) {
                    logger.info(`✅ Automated SMS sent for ${callSid} (SID: ${smsResult.sid})`);
                } else {
                    logger.warn(`⚠️ SMS failed for ${callSid}: ${smsResult.error}`);
                }
            } catch (smsError) {
                logger.error(`❌ SMS error for ${callSid}: ${smsError.message}`);
            }
        } else {
            // FAILED: Send to failed-bookings API
            logger.info(`⚠️ Failed/incomplete booking detected for ${callSid} — sending to Failed Booking API`);
            await sendFailedBookingToApi(existingData.restaurantId, bookingData, transcriptText);
        }

        const updatedDoc = await callLogRef.get();
        return updatedDoc.data();

    } catch (error) {
        logger.error(`❌ Error updating CallLog for ${callSid}: ${error.message}`);
        throw error;
    }
};

