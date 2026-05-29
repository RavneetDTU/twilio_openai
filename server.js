import express from 'express';
import http from 'http';
import logger from './src/utils/logger.js';
import WebSocket, { WebSocketServer } from "ws";
import dotenv from 'dotenv';
import bodyParser from 'body-parser';
import Twilio from 'twilio';
import cors from 'cors';

// 1. IMPORT THE DISPATCHER
import { getPersonaByNumber } from './src/dispatcher.js';
import { createCallLog, updateCallLog } from './src/services/callService.js';
import { updateConfig, getRestaurantDetails, addQuestion, deleteQuestion } from './src/utils/config.js';
import smsRoutes from './src/routes/sms.js';
import bookingRoutes from './src/routes/booking.js';
import paymentRoutes from './src/routes/payment.js';
import payfastNotifyRoutes from './src/routes/payfastNotify.js';
import verifyRoutes from './src/routes/verify.js';
import refundRoutes from './src/routes/refund.js';
import './src/config/firebase.js'; // Initialize Firebase

dotenv.config();
const { OPENAI_API_KEY, PORT = 9000 } = process.env;

if (!OPENAI_API_KEY) {
    logger.error('Missing OpenAI API key.');
    process.exit(1);
}

const client = new Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

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


// handle recording completion
app.post('/recording-complete', async (req, res) => {
    logger.info("📨 /recording-complete endpoint hit");
    try {
        const { CallSid, RecordingUrl, RecordingDuration } = req.body;
        await updateCallLog({
            callSid: CallSid,
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
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: "Configuration file not found" });
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

    // VAD & turn-detection state
    let greetingCompleted = false;
    let twilioMediaFrames = 0;
    let twilioMediaFramesAfterGreeting = 0;
    let openAiAudioAppendFrames = 0;
    let lastTwilioMediaLogAt = 0;
    let lastOpenAiEventType = null;
    let lastOpenAiEventAt = null;
    let callerSpeechActive = false;
    let callerTurnCommitted = false;
    let callerTurnFallbackTimer = null;
    let callerTurnMaxTimer = null;
    let waitingForCallerAfterBot = false;
    let callerFramesSinceLastBot = 0;
    let noVadFallbackTimer = null;
    let localSpeechActive = false;
    let localSpeechStartedAt = null;
    let localLastVoiceAt = null;
    let localPeakAudioLevel = 0;

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

    // --- HELPER: Summarize OpenAI events for logging ---
    const summarizeOpenAiEvent = (response) => {
        const summary = {
            type: response.type,
            event_id: response.event_id,
            item_id: response.item_id,
            response_id: response.response?.id || response.response_id,
            status: response.response?.status || response.status,
        };

        if (response.type === 'session.updated') {
            summary.session_id = response.session?.id;
            summary.model = response.session?.model;
            summary.turn_detection = response.session?.audio?.input?.turn_detection?.type || null;
            summary.input_transcription = response.session?.audio?.input?.transcription?.model || null;
        }

        if (response.type === 'input_audio_buffer.speech_started' || response.type === 'input_audio_buffer.speech_stopped') {
            summary.audio_start_ms = response.audio_start_ms;
            summary.audio_end_ms = response.audio_end_ms;
        }

        if (response.type === 'input_audio_buffer.committed') {
            summary.previous_item_id = response.previous_item_id;
        }

        if (response.type === 'response.done') {
            summary.status_details = response.response?.status_details || null;
            summary.usage = response.response?.usage || null;
        }

        return JSON.stringify(summary);
    };

    const shouldLogOpenAiEvent = (type) => {
        if (type === 'response.output_audio.delta' || type === 'response.output_audio_transcript.delta') {
            return false;
        }

        return [
            'session.created',
            'session.updated',
            'error',
            'input_audio_buffer.speech_started',
            'input_audio_buffer.speech_stopped',
            'input_audio_buffer.committed',
            'conversation.item.input_audio_transcription.delta',
            'conversation.item.input_audio_transcription.completed',
            'conversation.item.input_audio_transcription.failed',
            'response.created',
            'response.done',
            'response.output_audio.done',
            'response.output_audio_transcript.done',
            'response.function_call_arguments.done',
            'rate_limits.updated'
        ].includes(type);
    };

    // --- LOCAL VAD: decode µ-law sample to linear PCM ---
    const decodeMuLawSample = (byte) => {
        const muLaw = ~byte & 0xff;
        const sign = muLaw & 0x80;
        const exponent = (muLaw >> 4) & 0x07;
        const mantissa = muLaw & 0x0f;
        let sample = ((mantissa << 3) + 0x84) << exponent;
        sample -= 0x84;
        return sign ? -sample : sample;
    };

    const getPcmuAudioLevel = (payload) => {
        const buffer = Buffer.from(payload, 'base64');
        if (!buffer.length) return 0;

        let sumSquares = 0;
        for (const byte of buffer) {
            const sample = decodeMuLawSample(byte);
            sumSquares += sample * sample;
        }

        return Math.sqrt(sumSquares / buffer.length) / 32768;
    };

    const resetLocalTurnAudio = () => {
        localSpeechActive = false;
        localSpeechStartedAt = null;
        localLastVoiceAt = null;
        localPeakAudioLevel = 0;
    };

    const clearCallerTurnFallback = () => {
        if (callerTurnFallbackTimer) {
            clearTimeout(callerTurnFallbackTimer);
            callerTurnFallbackTimer = null;
        }
        if (callerTurnMaxTimer) {
            clearTimeout(callerTurnMaxTimer);
            callerTurnMaxTimer = null;
        }
        if (noVadFallbackTimer) {
            clearTimeout(noVadFallbackTimer);
            noVadFallbackTimer = null;
        }
    };

    const forceCommitCallerTurn = (reason, options = {}) => {
        const { allowWithoutSpeechStarted = false } = options;

        if (!openAiWs || openAiWs.readyState !== WebSocket.OPEN || callerTurnCommitted) {
            return;
        }

        if (!callerSpeechActive && !allowWithoutSpeechStarted) {
            return;
        }

        callerTurnCommitted = true;
        callerSpeechActive = false;
        waitingForCallerAfterBot = false;
        resetLocalTurnAudio();
        clearCallerTurnFallback();

        logger.warn(`OpenAI VAD did not finish caller turn; forcing input_audio_buffer.commit + response.create. callSid=${sessionCallSid || 'unknown'}, reason=${reason}, framesAfterGreeting=${twilioMediaFramesAfterGreeting}, framesSinceLastBot=${callerFramesSinceLastBot}, lastTwilioTs=${latestMediaTimestamp}`);

        try {
            openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        } catch (commitErr) {
            logger.error(`Failed to force caller turn commit. callSid=${sessionCallSid || 'unknown'}, error=${commitErr.message}`);
        }
    };

    const scheduleCallerTurnFallback = () => {
        if (!callerSpeechActive || callerTurnCommitted) return;

        // Reset the sliding window timer every time a new media frame arrives.
        // 800ms after the last frame following speech_started = natural end of turn.
        if (callerTurnFallbackTimer) clearTimeout(callerTurnFallbackTimer);
        callerTurnFallbackTimer = setTimeout(() => forceCommitCallerTurn('no_media_after_speech_started_800ms'), 800);

        if (!callerTurnMaxTimer) {
            callerTurnMaxTimer = setTimeout(() => forceCommitCallerTurn('max_speech_turn_12000ms'), 12000);
        }
    };

    const scheduleNoVadFallback = () => {
        if (!waitingForCallerAfterBot || callerSpeechActive || callerTurnCommitted || noVadFallbackTimer) {
            return;
        }

        // 4000ms: if bot finished speaking and user audio is flowing but OpenAI
        // never fires speech_started, commit what we have and get a response.
        noVadFallbackTimer = setTimeout(() => {
            if (waitingForCallerAfterBot && !callerSpeechActive && !callerTurnCommitted && callerFramesSinceLastBot >= 25) {
                forceCommitCallerTurn('caller_audio_after_bot_but_no_speech_started_4000ms', {
                    allowWithoutSpeechStarted: true
                });
            }
        }, 4000);
    };

    const updateLocalTurnDetection = (payload) => {
        if (!waitingForCallerAfterBot || callerTurnCommitted) return;

        const timestampMs = Number(latestMediaTimestamp) || 0;
        const audioLevel = getPcmuAudioLevel(payload);
        localPeakAudioLevel = Math.max(localPeakAudioLevel, audioLevel);

        const voiceThreshold = 0.018;
        const silenceAfterSpeechMs = 1200;
        const maxTurnMs = 12000;

        if (audioLevel >= voiceThreshold) {
            localLastVoiceAt = timestampMs;

            if (!localSpeechActive) {
                localSpeechActive = true;
                localSpeechStartedAt = timestampMs;
                logger.info(`Local VAD detected caller speech. callSid=${sessionCallSid || 'unknown'}, audioLevel=${audioLevel.toFixed(4)}, twilioTs=${latestMediaTimestamp}`);
            }
        }

        if (!localSpeechActive) return;

        const silenceMs = timestampMs - (localLastVoiceAt || timestampMs);
        const turnMs = timestampMs - (localSpeechStartedAt || timestampMs);

        if (turnMs >= maxTurnMs) {
            forceCommitCallerTurn('local_vad_max_turn_12000ms', { allowWithoutSpeechStarted: true });
            return;
        }

        if (turnMs >= 600 && silenceMs >= silenceAfterSpeechMs) {
            logger.info(`Local VAD detected end of caller turn. callSid=${sessionCallSid || 'unknown'}, silenceMs=${silenceMs}, turnMs=${turnMs}, peakLevel=${localPeakAudioLevel.toFixed(4)}`);
            forceCommitCallerTurn('local_vad_silence_after_speech_1200ms', { allowWithoutSpeechStarted: true });
        }
    };

    // --- TWILIO MESSAGE LISTENER ---
    connection.on('message', (message) => {
        const data = JSON.parse(message);

        // A. Handle 'start' event (Identify Caller & Connect AI)
        if (data.event === 'start') {
            streamSid = data.start.streamSid;
            sessionCallSid = data.start.callSid;  // Capture Twilio CallSid for later hangup
            const callerPhone = data.start.customParameters?.caller;
            logger.info(`📞 Caller Phone Identified: ${callerPhone}`);
            logger.info(`🆔 Session CallSid captured: ${sessionCallSid}`);

            // Ask Dispatcher for Config
            currentPersona = getPersonaByNumber(callerPhone);
            logger.info(`✅ Loaded Persona: ${currentPersona.name}`);

            // Connect to OpenAI with specific config
            connectToOpenAI(currentPersona);
        }

        // B. Handle Media (Audio from user)
        if (data.event === 'media') {
            latestMediaTimestamp = data.media.timestamp;
            twilioMediaFrames += 1;

            if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
                try {
                    openAiWs.send(JSON.stringify({
                        type: 'input_audio_buffer.append',
                        audio: data.media.payload
                    }));
                    openAiAudioAppendFrames += 1;
                } catch (sendErr) {
                    logger.error(`Realtime audio append failed for ${sessionCallSid || 'unknown call'}: ${sendErr.message}`);
                }
            } else if (twilioMediaFrames <= 5 || twilioMediaFrames % 250 === 0) {
                logger.warn(`Twilio media received but OpenAI WS is not open. callSid=${sessionCallSid || 'unknown'}, openAiState=${openAiWs?.readyState ?? 'not_created'}, frames=${twilioMediaFrames}`);
            }

            if (greetingCompleted) {
                twilioMediaFramesAfterGreeting += 1;
                scheduleCallerTurnFallback();
                if (waitingForCallerAfterBot && !callerSpeechActive && !callerTurnCommitted) {
                    callerFramesSinceLastBot += 1;
                    scheduleNoVadFallback();
                }
                updateLocalTurnDetection(data.media.payload);
                const ts = Number(latestMediaTimestamp) || 0;
                if (twilioMediaFramesAfterGreeting <= 5 || ts - lastTwilioMediaLogAt >= 5000) {
                    lastTwilioMediaLogAt = ts;
                    logger.info(`After greeting: Twilio media frame received and forwarded. callSid=${sessionCallSid || 'unknown'}, afterGreetingFrames=${twilioMediaFramesAfterGreeting}, totalForwarded=${openAiAudioAppendFrames}, twilioTs=${latestMediaTimestamp}, openAiState=${openAiWs?.readyState}`);
                }
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
            // Per official OpenAI Realtime API docs:
            // - semantic_vad: model decides end-of-turn by meaning, not silence — reliable on telephony
            // - noise_reduction far_field: cleans telephony/Twilio line noise before VAD
            // - transcription: separate gpt-4o-transcribe model for accurate caller text
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    type: 'realtime',
                    model: persona.model,
                    output_modalities: ['audio'],
                    audio: {
                        input: {
                            format: { type: 'audio/pcmu' },
                            transcription: { model: 'gpt-4o-transcribe' },
                            noise_reduction: { type: 'far_field' },
                            turn_detection: {
                                type: 'semantic_vad',
                                eagerness: 'high',
                                create_response: true,
                                interrupt_response: true
                            }
                        },
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
            logger.info(`Sending session.update to OpenAI. callSid=${sessionCallSid || 'unknown'}, persona=${persona.name}, model=${persona.model}, voice=${persona.voice}, inputFormat=audio/pcmu, turnDetection=semantic_vad`);
            openAiWs.send(JSON.stringify(sessionUpdate));

            // Trigger greeting
            logger.info(`Sending greeting trigger to OpenAI. callSid=${sessionCallSid || 'unknown'}`);
            openAiWs.send(JSON.stringify({
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: 'Say your greeting.' }]
                }
            }));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
            logger.info(`Initial response.create sent. callSid=${sessionCallSid || 'unknown'}`);
        };

        openAiWs.on('open', () => {
            logger.info(`🔓 Connected to OpenAI for ${persona.name}`);
            setTimeout(initializeSession, 100);
        });

        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);
                lastOpenAiEventType = response.type;
                lastOpenAiEventAt = new Date();

                if (shouldLogOpenAiEvent(response.type)) {
                    logger.info(`OpenAI event: ${summarizeOpenAiEvent(response)}`);
                }

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

                            // Map persona id → restaurantId in prompts.json
                            const personaToRestaurantId = { billy: '1', bjorn: '3', wine_tasting: '4', la_retha: '5' };
                            const restaurantId = personaToRestaurantId[persona.id] || '1';
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
                    callerSpeechActive = true;
                    callerTurnCommitted = false;
                    waitingForCallerAfterBot = false;
                    callerFramesSinceLastBot = 0;
                    resetLocalTurnAudio();
                    scheduleCallerTurnFallback();
                    logger.info(`OpenAI detected caller speech. callSid=${sessionCallSid || 'unknown'}, afterGreeting=${greetingCompleted}, twilioTs=${latestMediaTimestamp}, framesAfterGreeting=${twilioMediaFramesAfterGreeting}`);
                    handleSpeechStartedEvent();
                }

                if (response.type === 'input_audio_buffer.speech_stopped') {
                    logger.info(`OpenAI detected caller speech stopped. callSid=${sessionCallSid || 'unknown'}, twilioTs=${latestMediaTimestamp}, framesAfterGreeting=${twilioMediaFramesAfterGreeting}`);
                }

                if (response.type === 'input_audio_buffer.committed') {
                    callerSpeechActive = false;
                    callerTurnCommitted = true;
                    waitingForCallerAfterBot = false;
                    callerFramesSinceLastBot = 0;
                    resetLocalTurnAudio();
                    clearCallerTurnFallback();
                    logger.info(`OpenAI committed caller audio buffer. callSid=${sessionCallSid || 'unknown'}, item_id=${response.item_id || '[none]'}`);
                }

                if (response.type === 'response.created') {
                    callerSpeechActive = false;
                    callerTurnCommitted = false;
                    waitingForCallerAfterBot = false;
                    callerFramesSinceLastBot = 0;
                    resetLocalTurnAudio();
                    clearCallerTurnFallback();
                }

                // 3. USER TRANSCRIPTION (What YOU said)
                // Per docs: delta events use response.delta, completed events use response.transcript
                if (response.type === 'conversation.item.input_audio_transcription.delta') {
                    const userText = (response.delta || '').trim();
                    if (userText) logger.info(`USER transcript delta: ${userText}`);
                }

                if (response.type === 'conversation.item.input_audio_transcription.completed') {
                    const userText = (response.transcript || '').trim();
                    logger.info(`USER transcript completed: ${userText || '[empty]'}`);
                }

                if (response.type === 'conversation.item.input_audio_transcription.failed') {
                    logger.error(`USER transcription failed: ${JSON.stringify(response.error || response, null, 2)}`);
                }

                // 4. BOT RESPONSE (What AI said) + Auto-Hangup on Closing Phrase
                if (response.type === 'response.output_audio_transcript.done') {
                    const botText = response.transcript.trim();
                    logger.info(`🤖 BOT: ${botText}`);
                    if (!greetingCompleted) {
                        greetingCompleted = true;
                        logger.info(`Greeting completed. Watching caller audio/OpenAI VAD now. callSid=${sessionCallSid || 'unknown'}, totalTwilioFrames=${twilioMediaFrames}, totalForwarded=${openAiAudioAppendFrames}`);
                    }
                    waitingForCallerAfterBot = true;
                    callerFramesSinceLastBot = 0;
                    callerTurnCommitted = false;
                    resetLocalTurnAudio();
                    clearCallerTurnFallback();
                    logger.info(`Bot finished speaking. Waiting for next caller turn. callSid=${sessionCallSid || 'unknown'}, lastBot="${botText.substring(0, 80)}"`);

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
                        logger.info(`✅ Closing phrase detected: "${botText.substring(0, 60)}..." — scheduling call termination in 8s...`);

                        setTimeout(async () => {
                            try {
                                await client.calls(sessionCallSid).update({ status: 'completed' });
                                logger.info(`📵 Call ${sessionCallSid} ended successfully via Twilio REST API.`);
                            } catch (hangupErr) {
                                logger.error(`❌ Failed to end call ${sessionCallSid}: ${hangupErr.message}`);
                            }
                        }, 8000); // 8-second delay — lets the audio finish before hanging up
                    }
                }

            } catch (err) {
                logger.error(`Error processing OpenAI message: ${err.message}`);
            }
        });

        openAiWs.on('close', (code, reason) => logger.info(`OpenAI Closed. callSid=${sessionCallSid || 'unknown'}, code=${code}, reason=${reason?.toString() || '[none]'}, lastEvent=${lastOpenAiEventType || '[none]'}, lastEventAt=${lastOpenAiEventAt ? lastOpenAiEventAt.toISOString() : '[none]'}`));
        openAiWs.on('error', (err) => logger.error(`OpenAI Error: ${err.message}`));
    };

    connection.on('close', () => {
        clearCallerTurnFallback();
        if (openAiWs && openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
        logger.info(`Client disconnected. callSid=${sessionCallSid || 'unknown'}, twilioFrames=${twilioMediaFrames}, afterGreetingFrames=${twilioMediaFramesAfterGreeting}, forwardedToOpenAI=${openAiAudioAppendFrames}, lastOpenAIEvent=${lastOpenAiEventType || '[none]'}`);
    });
});

server.listen(PORT, () => console.log(`Server listening on ${PORT}`));