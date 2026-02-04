import { db } from '../config/firebase.js';
import { downloadFile } from '../utils/download.js';
import { transcribeAudio } from '../utils/transcription.js';
import { extractBookingData } from '../utils/extraction.js';
import { v4 as uuidv4 } from 'uuid';
import smsService from './smsService.js';
import path from 'path';

/**
 * Helper to determine Restaurant ID from the Bot's Phone Number.
 * @param {string} botPhone 
 * @returns {string} restaurantId
 */
const getRestaurantId = (botPhone) => {
    const mapping = {
        '+1234567890': 'restaurant_A',
        '+0987654321': 'restaurant_B'
    };
    return mapping[botPhone] || 'default_restaurant';
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
        const restaurantId = getRestaurantId(to);
        const paymentId = uuidv4(); // Generate unique payment ID

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
                bookingTime: null,
                guests: null,
                phoneNo: null,
                allergy: null
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

        // Use callSid as document ID for easy retrieval
        await db.collection('callLogs').doc(callSid).set(callLogData);

        console.log(`✅ CallLog Created: ${callSid} (Restaurant: ${restaurantId}, Payment ID: ${paymentId})`);
        return callLogData;
    } catch (error) {
        console.error(`❌ Error creating CallLog for ${callSid}:`, error);
        throw error;
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

        // Download the file
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

        // Update the document
        const updateData = {
            recordingUrl,
            localFilePath: savedPath,
            transcription: transcriptText,
            booking: bookingData || {
                name: null,
                bookingTime: null,
                guests: null,
                phoneNo: null,
                allergy: null
            },
            duration,
            status: 'completed',
            updatedAt: new Date()
        };

        await callLogRef.update(updateData);

        console.log(`✅ CallLog Updated: ${callSid} -> URL: ${recordingUrl}`);

        // Get existing data for payment ID
        const existingData = callLogDoc.data();

        // Send automated SMS if booking data is complete
        if (bookingData && bookingData.name && bookingData.phoneNo && bookingData.guests) {
            console.log(`📱 Attempting to send automated SMS for ${callSid}...`);

            try {
                const smsResult = await smsService.sendAutomatedSms(
                    bookingData,
                    existingData.paymentId
                );

                // Update SMS status in Firestore
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

        // Return updated document
        const updatedDoc = await callLogRef.get();
        return updatedDoc.data();

    } catch (error) {
        console.error(`❌ Error updating CallLog for ${callSid}:`, error);
        throw error;
    }
};
