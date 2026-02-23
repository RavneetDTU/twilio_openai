import { db } from '../config/firebase.js';
import { downloadFile } from '../utils/download.js';
import { transcribeAudio } from '../utils/transcription.js';
import { extractBookingData } from '../utils/extraction.js';
import { v4 as uuidv4 } from 'uuid';
import smsService from './smsService.js';
import path from 'path';

const RESERVATION_API_BASE = 'https://mybookiapis.jarviscalling.ai/restaurants';

/**
 * Helper to determine Restaurant ID from the CALLER's Phone Number.
 * @param {string} callerPhone - the 'From' number (customer who called)
 * @returns {string} restaurantId
 */
const getRestaurantId = (callerPhone) => {
    const mapping = {
        '+27844500010': '2',   // ryan
        '+27765575522': '3',   // bjorn
        '+918930276263': '1',  // billy
        '+918319377879': '1',  // billy
    };
    const id = mapping[callerPhone] || '1'; // default to billy (1)
    console.log(`🏪 Restaurant ID resolved: ${id} (for caller: ${callerPhone})`);
    return id;
};

/**
 * Creates a new CallLog document when a call starts.
 * @param {Object} params
 * @param {string} params.callSid
 * @param {string} params.from - Customer Phone
 * @param {string} params.to - Bot Phone
 */
export const createCallLog = async ({ callSid, from, to }) => {
    console.log(`📝 Creating CallLog for SID: ${callSid}`);

    try {
        // Map by CALLER number (from), not bot phone
        const restaurantId = getRestaurantId(from);
        const paymentId = uuidv4();

        const callLogData = {
            callSid,
            customerPhone: from,
            botPhone: to,
            restaurantId,
            paymentId,
            status: 'active',
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
                notes: null
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

        console.log(`✅ CallLog Created: ${callSid} (Restaurant ID: ${restaurantId}, Payment ID: ${paymentId})`);
        return callLogData;
    } catch (error) {
        console.error(`❌ Error creating CallLog for ${callSid}:`, error);
        throw error;
    }
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

    console.log(`📡 Sending reservation to API: ${url}`);
    console.log(`📦 Payload: ${JSON.stringify(payload, null, 2)}`);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`❌ Reservation API error (${response.status}): ${errorText}`);
            return { success: false, status: response.status, error: errorText };
        }

        const result = await response.json();
        console.log(`✅ Reservation API success:`, JSON.stringify(result, null, 2));
        return { success: true, data: result };

    } catch (apiError) {
        console.error(`❌ Reservation API request failed:`, apiError.message);
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
    console.log(`📝 Updating CallLog for SID: ${callSid}`);

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
            console.error(`❌ Failed processing (download/transcribe/extract) for ${callSid}:`, processErr);
        }

        // Get reference to the document
        const callLogRef = db.collection('callLogs').doc(callSid);
        const callLogDoc = await callLogRef.get();

        if (!callLogDoc.exists) {
            console.warn(`⚠️ Warning: No active CallLog found for SID: ${callSid}`);
            return null;
        }

        const existingData = callLogDoc.data();
        console.log(`🏪 Booking Restaurant ID: ${existingData.restaurantId}`);

        // Update the document
        const updateData = {
            recordingUrl,
            localFilePath: savedPath,
            transcription: transcriptText,
            booking: bookingData || {
                name: null,
                date: null,
                time: null,
                guests: null,
                phoneNo: null,
                allergy: null,
                notes: null
            },
            duration,
            status: 'completed',
            updatedAt: new Date()
        };

        await callLogRef.update(updateData);
        console.log(`✅ CallLog Updated: ${callSid} -> URL: ${recordingUrl}`);

        // Send to external Reservation API if booking data is present
        if (bookingData && bookingData.name) {
            await sendReservationToApi(existingData.restaurantId, bookingData, transcriptText);
        } else {
            console.log(`ℹ️ Skipping Reservation API - no booking data for ${callSid}`);
        }

        // Send automated SMS if booking data is complete
        if (bookingData && bookingData.name && bookingData.phoneNo && bookingData.guests) {
            console.log(`📱 Attempting to send automated SMS for ${callSid}...`);

            try {
                const smsResult = await smsService.sendAutomatedSms(
                    bookingData,
                    existingData.paymentId
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
                    console.log(`✅ Automated SMS sent for ${callSid} (SID: ${smsResult.sid})`);
                } else {
                    console.warn(`⚠️ SMS failed for ${callSid}: ${smsResult.error}`);
                }
            } catch (smsError) {
                console.error(`❌ SMS error for ${callSid}:`, smsError.message);
            }
        } else {
            console.log(`ℹ️ Skipping SMS - incomplete booking data for ${callSid}`);
        }

        const updatedDoc = await callLogRef.get();
        return updatedDoc.data();

    } catch (error) {
        console.error(`❌ Error updating CallLog for ${callSid}:`, error);
        throw error;
    }
};
