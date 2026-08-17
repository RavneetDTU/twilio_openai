import bodyParser from 'body-parser';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import http from 'http';
import Twilio from 'twilio';
import WebSocket, { WebSocketServer } from "ws";
import logger from './src/utils/logger.js';

// 1. IMPORT THE DISPATCHER
import './src/config/firebase.js'; // Initialize Firebase
import { getTenantByNumber } from './src/dispatcher.js';
import bookingRoutes from './src/routes/booking.js';
import openaiWebhookRoutes, { pendingSipCalls } from './src/routes/openaiWebhook.js';
import payfastCheckoutPage, {
    paymentFailHandler,
    paymentSuccessHandler,
} from './src/routes/payfastCheckoutPage.js';
import payfastNotifyRoutes from './src/routes/payfastNotify.js';
import paymentRoutes from './src/routes/payment.js';
import refundRoutes from './src/routes/refund.js';
import smsRoutes from './src/routes/sms.js';
import verifyRoutes from './src/routes/verify.js';
import { createCallLog, patchCallLogTenant, updateCallLog } from './src/services/callService.js';
import { rejectOpenAICall } from './src/services/openaiCallsService.js';
import { activeSipSessions } from './src/services/realtimeSipSession.js';
import { createTenant } from './src/services/tenantService.js';
import { addQuestion, deleteQuestion, getRestaurantDetails, updateConfig } from './src/utils/config.js';

dotenv.config();
const { OPENAI_API_KEY, PORT = 9000 } = process.env;

// Feature flag for the SIP Trunking transport migration (see docs/development.md).
// Defaults to false — when false, /incoming-call behaves EXACTLY as it does
// today (Media Streams). Only when explicitly set to 'true' in .env does the
// new Conference + SIP Participant branch activate.
const SIP_TRUNKING_ENABLED = process.env.SIP_TRUNKING_ENABLED === 'true';

/** Max time to keep the caller on ringback while OpenAI accept + sideband configure. */
const SIP_RING_SETUP_TIMEOUT_MS = 12000;

if (!OPENAI_API_KEY) {
    logger.error('Missing OpenAI API key.');
    process.exit(1);
}

const client = new Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// OpenAI Realtime SIP webhook — needs the raw request body for HMAC signature
// verification, so it is mounted with its own JSON parser BEFORE the generic
// body-parser/express.json() middleware below. This is scoped to this one
// path only and does not change parsing behavior for any other route.
app.use('/webhooks/openai', express.json({
    limit: '2mb',
    verify: (req, res, buf) => { req.rawBody = buf; }
}), openaiWebhookRoutes);

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.json())
app.use(cors(
    {
        origin: "*",
        credentials: true
    }
))


// Root route
app.get('/', (req, res) => res.json({ message: 'Server is running!' }));

// SMS API routes
app.use('/api/sms', smsRoutes);

// General Booking API routes
app.use('/api/booking', bookingRoutes);

// Payment API routes
app.use('/api/payment', paymentRoutes);

// Backend PayFast checkout page (split setup posted here). SMS: PAYMENT_FRONTEND_URL/payment/:id
app.use('/payment', payfastCheckoutPage);
app.get('/payment-success', paymentSuccessHandler);
app.get('/payment-fail', paymentFailHandler);

// Payfast ITN (Instant Transaction Notification) routes
app.use('/api/payfast', payfastNotifyRoutes);

// Phone Verification routes
app.use('/api/verify', verifyRoutes);

// Refund API routes
app.use('/api/refund', refundRoutes);

// 2. INCOMING CALL - Pass Caller Number to WebSocket
app.all('/incoming-call', async (req, res) => {
    const callerNumber = req.body.From || "Unknown";
    const callSid = req.body.CallSid;
    const to = req.body.To || "Unknown";
     
    logger.info('#---------------------NEXT CALL LOG--------------------------------#')
    logger.info(`📞 Incoming call from: ${callerNumber} to ${to}`);
    logger.info(`🆔 CallSid: ${callSid}`);

    // Create Call Log in DB
    try {
        await createCallLog({ callSid, from: callerNumber, to });
    } catch (dbError) {
        logger.error(`❌ Failed to create call log: ${dbError.message}`);
    }

    // =========================================================================
    // SIP TRUNKING TRANSPORT (feature-flagged — see docs/development.md)
    // Setup (tenant, OpenAI SIP dial, /accept, sideband session.update) runs
    // WHILE THE CALLER STILL HEARS RINGBACK — we hold this Twilio webhook
    // response until OpenAI is ready. Only then do we return Conference TwiML
    // (which answers the call). Greeting fires when the customer joins
    // (/conference-events). Recording: Dial record-from-answer-dual.
    // =========================================================================
    if (SIP_TRUNKING_ENABLED && callSid) {
        try {
            const persona = await getTenantByNumber(callerNumber);
            logger.info(`✅ [SIP] Loaded Persona: ${persona.name}`);

            patchCallLogTenant(callSid, persona.restaurantId, persona.name)
                .catch(err => logger.error(`❌ [SIP] patchCallLogTenant error: ${err.message}`));

            let resolveReady;
            let rejectReady;
            const readyPromise = new Promise((resolve, reject) => {
                resolveReady = resolve;
                rejectReady = reject;
            });

            pendingSipCalls.set(callSid, {
                persona,
                createdAt: Date.now(),
                resolveReady,
                rejectReady,
            });

            // Dial OpenAI without blocking the ready wait — INVITE and webhook/accept
            // must overlap while the caller still hears PSTN ringback.
            const sipUri = `sip:${process.env.OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls?X-Call-Sid=${callSid}`;
            const dialPromise = client.conferences(callSid).participants.create({
                from: callerNumber,
                to: sipUri,
                label: 'ai-agent',
                earlyMedia: false,
                callToken: req.body.CallToken,
            }).then((participant) => {
                logger.info(`📞 [SIP] AI participant dial started (${participant.callSid || participant.uri || 'ok'})`);
            }).catch((dialErr) => {
                logger.error(`❌ [SIP] participants.create failed: ${dialErr.message}`);
                rejectReady(dialErr);
            });

            logger.info(`⏳ [SIP] Waiting up to ${SIP_RING_SETUP_TIMEOUT_MS}ms for OpenAI ready (caller on ringback)...`);

            let session;
            try {
                session = await Promise.race([
                    readyPromise,
                    new Promise((_, reject) =>
                        setTimeout(
                            () => reject(new Error('SIP setup timed out while caller was ringing')),
                            SIP_RING_SETUP_TIMEOUT_MS
                        )
                    ),
                ]);
            } catch (waitErr) {
                const entry = pendingSipCalls.get(callSid);
                if (entry?.openAiCallId) {
                    rejectOpenAICall(entry.openAiCallId).catch(() => {});
                }
                pendingSipCalls.delete(callSid);
                // Avoid unhandled rejection if dial is still in flight
                dialPromise.catch(() => {});
                throw waitErr;
            }

            pendingSipCalls.delete(callSid);

            const recordingCallback = `https://${req.headers.host}/recording-complete?callSid=${encodeURIComponent(callSid)}`;
            const conferenceEvents = `https://${req.headers.host}/conference-events`;
            // Answer the caller ONLY now — OpenAI sideband is already configured.
            const sipTwimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
            <Dial record="record-from-answer-dual" recordingStatusCallback="${recordingCallback}" recordingStatusCallbackEvent="completed">
                <Conference endConferenceOnExit="true" startConferenceOnEnter="true" beep="false" waitUrl="" participantLabel="customer" statusCallback="${conferenceEvents}" statusCallbackEvent="join">${callSid}</Conference>
            </Dial>
        </Response>`;

            logger.info(`⏺️ [SIP] Answering caller into Conference (OpenAI already ready) for ${callSid}`);
            res.type('text/xml').send(sipTwimlResponse);

            // Greeting TTS must start in the same tick as answer — no post-connect silence.
            session.sendGreeting();

            return;

        } catch (sipErr) {
            logger.error(`❌ [SIP] Failed to bridge via SIP Trunking: ${sipErr.message}`);
            if (/already decided/i.test(sipErr.message)) {
                logger.error(
                    '❌ [SIP] OpenAI call was accepted/rejected elsewhere. For local tests, OpenAI webhook URL must point ONLY at this ngrok host — disable production openaisip.ayurvedicpromise.com while testing.'
                );
            }
            pendingSipCalls.delete(callSid);
            // Falls through to Media Streams — slower greeting; fix webhook ownership to avoid this.
        }
    }

    // Media Streams path only — Call-level recording is eligible here.
    if (callSid) {
        client.calls(callSid).recordings.create(
            {
                recordingChannels: 'dual',
                recordingStatusCallbackEvent: ['completed'],
                recordingStatusCallback: `https://${req.headers.host}/recording-complete`
            }

        )
            .then(rec => logger.info(`⏺️ Dual-channel recording started: ${rec.sid}`))
            .catch(err => logger.error(`❌ Recording failed: ${err.message}`));
    }

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
            <Connect>
                <Stream url="wss://${req.headers.host}/media-stream">
                    <Parameter name="caller" value="${callerNumber}" />
                </Stream>
            </Connect>
        </Response>`;

    res.type('text/xml').send(twimlResponse);
});


// Conference participant join — fire SIP greeting the moment the customer is bridged.
app.post('/conference-events', (req, res) => {
    res.sendStatus(200);

    const eventName = req.body.StatusCallbackEvent || req.body.EventName;
    const label = req.body.ParticipantLabel;
    const conferenceName = req.body.FriendlyName;
    const participantCallSid = req.body.CallSid;

    logger.info(
        `[SIP] Conference event: ${eventName} label=${label || '-'} friendly=${conferenceName || '-'} callSid=${participantCallSid || '-'}`
    );

    if (eventName !== 'participant-join') return;
    // AI participant is dialed in before statusCallback is attached; ignore if it still fires.
    if (label === 'ai-agent') return;

    const session =
        activeSipSessions.get(conferenceName) ||
        activeSipSessions.get(participantCallSid);

    if (session) {
        logger.info(`👋 [SIP] Customer joined conference ${conferenceName || participantCallSid} — greeting now`);
        session.sendGreeting();
    } else {
        logger.warn(`[SIP] Participant joined ${conferenceName || participantCallSid} but no activeSipSession`);
    }
});


// handle recording completion
app.post('/recording-complete', async (req, res) => {
    logger.info("📨 /recording-complete endpoint hit");
    try {
        const { CallSid, RecordingUrl, RecordingDuration } = req.body;
        // SIP Dial recording may rely on ?callSid= query fallback (see /incoming-call SIP branch).
        const resolvedCallSid = CallSid || req.query.callSid;
        await updateCallLog({
            callSid: resolvedCallSid,
            recordingUrl: RecordingUrl,
            duration: RecordingDuration
        });
        res.sendStatus(200);
    } catch (error) {
        logger.error(`❌ Error in /recording-complete route: ${error.message}`);
        res.sendStatus(500);
    }
});



// Configuration Update Endpoint
app.post('/api/update-config', async (req, res) => {
    logger.info("⚙️ /update-config endpoint hit");
    try {
        const updatedConfig = await updateConfig(req.body);
        res.status(200).json({
            message: "Configuration updated successfully",
            config: updatedConfig
        });
    } catch (error) {
        if (error.message.includes("Invalid restaurantId") || error.message.includes("Missing required field")) {
            res.status(400).json({ error: error.message });
        } else if (
            error.message.includes('Restaurant not found') ||
            error.code === 'ENOENT'
        ) {
            res.status(404).json({ error: error.message || 'Restaurant not found' });
        } else {
            logger.error(`Server Error in /update-config: ${error.message}`);
            res.status(500).json({ error: "Internal Server Error" });
        }
    }
});

// =============================================================================
// QUESTION FLOW ROUTES
// =============================================================================

// POST /api/question/add
// Adds a new question to a restaurant's questionFlow.
// id and order are AUTO-GENERATED by the server — do NOT send them.
// Body: { restaurantId, question: { title, botMessage, isRequired, instructions? } }
app.post('/api/question/add', async (req, res) => {
    logger.info('➕ /api/question/add endpoint hit');
    try {
        const { restaurantId, question } = req.body;

        if (!restaurantId) {
            return res.status(400).json({ error: 'Missing required field: restaurantId' });
        }
        if (!question || typeof question !== 'object') {
            return res.status(400).json({ error: 'Invalid field: question must be an object' });
        }

        const updatedRestaurant = await addQuestion(restaurantId, question);

        return res.status(200).json({
            message: 'Question added successfully',
            questionFlow: updatedRestaurant.questionFlow,
        });
    } catch (error) {
        if (error.message.startsWith('Missing') || error.message.startsWith('Invalid')) {
            return res.status(400).json({ error: error.message });
        }
        if (error.message.includes('Restaurant not found')) {
            return res.status(404).json({ error: error.message });
        }
        logger.error(`Server Error in /api/question/add: ${error.message}`);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

// DELETE /api/question/delete
// Removes a question from a restaurant's questionFlow by its id.
// Body: { restaurantId, questionId }
app.delete('/api/question/delete', async (req, res) => {
    logger.info('🗑️ /api/question/delete endpoint hit');
    try {
        const { restaurantId, questionId } = req.body;

        if (!restaurantId) {
            return res.status(400).json({ error: 'Missing required field: restaurantId' });
        }
        if (!questionId) {
            return res.status(400).json({ error: 'Missing required field: questionId' });
        }

        const updatedRestaurant = await deleteQuestion(restaurantId, questionId);

        return res.status(200).json({
            message: 'Question deleted successfully',
            questionFlow: updatedRestaurant.questionFlow,
        });
    } catch (error) {
        if (error.message.startsWith('Missing')) {
            return res.status(400).json({ error: error.message });
        }
        if (error.message.includes('Restaurant not found') || error.message.startsWith('NOT_FOUND')) {
            return res.status(404).json({ error: error.message });
        }
        logger.error(`Server Error in /api/question/delete: ${error.message}`);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

// =============================================================================

// Get Restaurant Details Endpoint
app.get('/api/restaurant/:id/details', async (req, res) => {
    console.log(`🔍 /api/restaurant/${req.params.id}/details endpoint hit`);
    try {
        const restaurantId = req.params.id;
        const details = await getRestaurantDetails(restaurantId);
        res.status(200).json(details);
    } catch (error) {
        if (error.message.includes("Restaurant not found")) {
            res.status(404).json({ error: error.message });
        } else {
            console.log(`Server Error in GET details: ${error.message}`);
            res.status(500).json({ error: "Internal Server Error" });
        }
    }
});

// Handle Upgrade
server.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith('/media-stream')) {
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    } else {
        socket.destroy();
    }
});

// 3. WEBSOCKET LOGIC
wss.on('connection', (connection, req) => {
    logger.info('Client connected');

    // --- STATE VARIABLES ---
    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    // Call lifecycle state
    let sessionCallSid = null;      // Twilio CallSid — captured on 'start' event
    let bookingCompleted = false;   // Guard: prevents double-hangup if phrase appears twice

    // Default Persona (will be updated on 'start')
    let currentPersona = null;
    let openAiWs = null;

    // --- HELPER: INTERRUPTION HANDLING ---
    // When you talk, this function truncates the AI's audio immediately
    const handleSpeechStartedEvent = () => {
        if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
            const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;

            logger.info(`🚧 Interruption detected. Cancelling AI audio after ${elapsedTime}ms`);

            if (lastAssistantItem) {
                const truncateEvent = {
                    type: 'conversation.item.truncate',
                    item_id: lastAssistantItem,
                    content_index: 0,
                    audio_end_ms: elapsedTime,
                };
                openAiWs.send(JSON.stringify(truncateEvent));
            }

            connection.send(JSON.stringify({ event: 'clear', streamSid }));

            // Reset state
            markQueue = [];
            lastAssistantItem = null;
            responseStartTimestampTwilio = null;
        }
    };

    // --- HELPER: SEND MARK EVENT ---
    const sendMark = () => {
        if (streamSid) {
            const markEvent = {
                event: 'mark',
                streamSid,
                mark: { name: 'responsePart' },
            };
            connection.send(JSON.stringify(markEvent));
            markQueue.push('responsePart');
        }
    };

    // --- TWILIO MESSAGE LISTENER ---
    connection.on('message', (message) => {
        const data = JSON.parse(message);

        // A. Handle 'start' event (Identify Caller & Connect AI)
        if (data.event === 'start') {
            streamSid = data.start.streamSid;
            sessionCallSid = data.start.callSid;
            const callerPhone = data.start.customParameters?.caller;
            logger.info(`📞 Caller Phone Identified: ${callerPhone}`);
            logger.info(`🆔 Session CallSid captured: ${sessionCallSid}`);

            // Async IIFE — getTenantByNumber is now async (Firestore lookup)
            (async () => {
                try {
                    // Ask Dispatcher for Config (Firestore-backed, cache-first)
                    currentPersona = await getTenantByNumber(callerPhone);
                    logger.info(`✅ Loaded Persona: ${currentPersona.name}`);

                    // Patch the call log with the resolved tenant identity.
                    // createCallLog() runs ~1s earlier at /incoming-call time
                    // before the dispatcher has fired, so restaurantId/Name start null.
                    if (sessionCallSid) {
                        patchCallLogTenant(
                            sessionCallSid,
                            currentPersona.restaurantId,
                            currentPersona.name
                        ).catch(err => logger.error(`❌ patchCallLogTenant error: ${err.message}`));
                    }

                    // Connect to OpenAI with the resolved persona
                    connectToOpenAI(currentPersona);

                } catch (dispatchErr) {
                    logger.error(`❌ Dispatcher failed for ${callerPhone}: ${dispatchErr.message}`);
                }
            })();
        }

        // B. Handle Media (Audio from user)
        if (data.event === 'media') {
            latestMediaTimestamp = data.media.timestamp;
            if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
                openAiWs.send(JSON.stringify({
                    type: 'input_audio_buffer.append',
                    audio: data.media.payload
                }));
            }
        }

        // C. Handle Marks (Timing sync)
        if (data.event === 'mark') {
            if (markQueue.length > 0) markQueue.shift();
        }
    });

    // --- OPENAI CONNECTION FUNCTION ---
    const connectToOpenAI = (persona) => {
        openAiWs = new WebSocket(
            `wss://api.openai.com/v1/realtime?model=${persona.model}&temperature=${persona.temperature}`,
            { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
        );

        const initializeSession = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    type: 'realtime',
                    model: persona.model,
                    output_modalities: ['audio'],
                    audio: {
                        input: { format: { type: 'audio/pcmu' }, turn_detection: { type: 'server_vad' } },
                        output: {
                            format: { type: 'audio/pcmu' },
                            voice: persona.voice,
                            speed: persona.speed,
                        },
                    },
                    instructions: persona.instructions,
                    tools: [
                        {
                            type: 'function',
                            name: 'check_capacity_for_date',
                            description: 'Check how many seats are available at the restaurant on a specific date. Call this BEFORE confirming any reservation.',
                            parameters: {
                                type: 'object',
                                properties: {
                                    date: {
                                        type: 'string',
                                        description: 'The booking date in YYYY-MM-DD format (e.g. "2026-05-22")'
                                    }
                                },
                                required: ['date']
                            }
                        }
                    ],
                    tool_choice: 'auto',
                },
            };
            openAiWs.send(JSON.stringify(sessionUpdate));

            // Optional: Force a greeting
            openAiWs.send(JSON.stringify({
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: 'Say your greeting.' }]
                }
            }));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        };

        openAiWs.on('open', () => {
            logger.info(`🔓 Connected to OpenAI for ${persona.name}`);
            setTimeout(initializeSession, 100);
        });

        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                // DEBUG: Print EVERY event type we get
                // console.log("Received event:", response.type);

                // HANDLE OPENAI ERRORS
                if (response.type === 'error') {
                    logger.error(`❌ OpenAI Error Event: ${JSON.stringify(response.error, null, 2)}`);
                }

                // TOOL CALL: check_capacity_for_date
                // The AI calls this after learning the booking date from the caller.
                if (response.type === 'response.function_call_arguments.done' &&
                    response.name === 'check_capacity_for_date') {

                    (async () => {
                        try {
                            const args = JSON.parse(response.arguments);
                            const dateStr = args.date; // e.g. "2026-05-22"

                            // Re-read config fresh to get latest totalCapacity + otherBookingsByDate
                            const { getAvailableCapacityForDate } = await import('./src/services/capacityService.js');
                            const { getRestaurantDetails } = await import('./src/utils/config.js');

                            // restaurantId comes directly from the tenant config — no hardcoded map needed
                            const restaurantId = persona.restaurantId || persona.id;
                            const restaurantConfig = await getRestaurantDetails(restaurantId);
                            const settings = restaurantConfig?.settings || {};

                            const capacity = await getAvailableCapacityForDate(settings, restaurantId, dateStr);

                            logger.info(`📊 [Tool] check_capacity_for_date(${dateStr}) → available: ${capacity.available}`);

                            // Send the tool result back to OpenAI so the AI can speak it
                            openAiWs.send(JSON.stringify({
                                type: 'conversation.item.create',
                                item: {
                                    type: 'function_call_output',
                                    call_id: response.call_id,
                                    output: JSON.stringify({
                                        date: dateStr,
                                        totalCapacity: capacity.totalCapacity,
                                        aiBooked: capacity.aiBooked,
                                        otherSourceBookings: capacity.otherBookings,
                                        available: capacity.available,
                                        fullyBooked: capacity.available === 0
                                    })
                                }
                            }));

                            // Tell OpenAI to generate its next response using the tool result
                            openAiWs.send(JSON.stringify({ type: 'response.create' }));

                        } catch (toolErr) {
                            logger.error(`❌ [Tool] check_capacity_for_date failed: ${toolErr.message}`);
                        }
                    })();
                }

                // 1. Audio Delta (AI Speaking)
                if (response.type === 'response.output_audio.delta' && response.delta) {
                    connection.send(JSON.stringify({
                        event: 'media',
                        streamSid,
                        media: { payload: response.delta }
                    }));

                    if (!responseStartTimestampTwilio) {
                        responseStartTimestampTwilio = latestMediaTimestamp;
                    }
                    if (response.item_id) {
                        lastAssistantItem = response.item_id;
                    }
                    sendMark();
                }

                // 2. Speech Started (User Interrupting)
                if (response.type === 'input_audio_buffer.speech_started') {
                    handleSpeechStartedEvent();
                }

                // 3. USER TRANSCRIPTION (What YOU said)
                if (response.type === 'conversation.item.input_audio_transcription.delta') {
                    const userText = response.transcript.trim();
                    // console.log(`👤 USER: ${userText}`);
                }
                // console.log(response);

                // 4. BOT RESPONSE (What AI said) + Auto-Hangup on Closing Phrase
                if (response.type === 'response.output_audio_transcript.done') {
                    const botText = response.transcript.trim();
                    logger.info(`🤖 BOT: ${botText}`);

                    // --- AUTO-HANGUP: End call after bot delivers closing message ---
                    // Reservation close:       "...we look forward to welcoming you."
                    // Manager message close:   "...we look forward to speaking with you soon. Have a wonderful day!"
                    //   → Bot sometimes paraphrases the middle phrase, so we also match
                    //     "have a wonderful day" as a reliable end-of-manager-message signal.
                    // bookingCompleted flag ensures we only trigger this ONCE per call.
                    const isClosingMessage =
                        botText.toLowerCase().includes('look forward to welcoming you') ||
                        botText.toLowerCase().includes('look forward to speaking with you') ||
                        botText.toLowerCase().includes('have a wonderful day');

                    if (isClosingMessage && !bookingCompleted && sessionCallSid) {
                        bookingCompleted = true;
                        logger.info(`✅ Closing phrase detected: "${botText.substring(0, 60)}..." — scheduling call termination in 10s...`);

                        setTimeout(async () => {
                            try {
                                await client.calls(sessionCallSid).update({ status: 'completed' });
                                logger.info(`📵 Call ${sessionCallSid} ended successfully via Twilio REST API.`);
                            } catch (hangupErr) {
                                logger.error(`❌ Failed to end call ${sessionCallSid}: ${hangupErr.message}`);
                            }
                        }, 11000); // 8-second delay — lets the audio finish before hanging up
                    }
                }

            } catch (err) {
                logger.error(`Error processing OpenAI message: ${err.message}`);
            }
        });

        openAiWs.on('close', () => logger.info('OpenAI Closed'));
        openAiWs.on('error', (err) => logger.error(`OpenAI Error: ${err.message}`));
    };

    connection.on('close', () => {
        if (openAiWs && openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
        logger.info('Client disconnected');
    });
});

// =============================================================================
// POST /api/restaurant/create
// Onboards a new restaurant with smart defaults.
// Required fields: name, phoneNumbers, email, depositAmount, totalCapacity
// Everything else (hours, questionFlow, model, voice, etc.) is auto-filled.
// =============================================================================
app.post('/api/restaurant/create', async (req, res) => {
    logger.info('🏥 /api/restaurant/create endpoint hit');
    try {
        const { name, phoneNumbers, email, depositAmount, totalCapacity, restaurantId, ...optionals } = req.body;

        // Validate required fields
        const missing = [];
        if (!name)                        missing.push('name');
        if (!restaurantId)                missing.push('restaurantId');
        if (!phoneNumbers?.length)        missing.push('phoneNumbers');
        if (!email)                       missing.push('email');
        if (depositAmount === undefined)  missing.push('depositAmount');
        if (totalCapacity === undefined)  missing.push('totalCapacity');

        if (missing.length) {
            return res.status(400).json({
                error: `Missing required fields: ${missing.join(', ')}`,
                required: ['name', 'restaurantId', 'phoneNumbers', 'email', 'depositAmount', 'totalCapacity'],
                optional: ['currency', 'timezone', 'venueType', 'voice', 'greetingMessage', 'operatingHours'],
            });
        }

        const tenant = await createTenant({ name, phoneNumbers, email, depositAmount, totalCapacity, restaurantId, ...optionals });

        logger.info(`✅ Restaurant created: "${tenant.name}" (${tenant.restaurantId})`);
        return res.status(201).json({
            message: 'Restaurant created successfully',
            restaurantId: tenant.restaurantId,
            name: tenant.name,
            phoneNumbers: tenant.phoneNumbers,
        });

    } catch (error) {
        if (error.message.startsWith('Missing')) {
            return res.status(400).json({ error: error.message });
        }
        if (error.message.startsWith('DUPLICATE_ID')) {
            return res.status(409).json({ error: error.message });
        }
        logger.error(`❌ Error in /api/restaurant/create: ${error.message}`);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

server.listen(PORT, () => console.log(`Server listening on ${PORT}`));