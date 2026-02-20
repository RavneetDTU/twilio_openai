import express from 'express';
import http from 'http';
import WebSocket, { WebSocketServer } from "ws";
import dotenv from 'dotenv';
import bodyParser from 'body-parser';
import Twilio from 'twilio';
import cors from 'cors';

// 1. IMPORT THE DISPATCHER
import { getPersonaByNumber } from './src/dispatcher.js';
import { createCallLog, updateCallLog } from './src/services/callService.js';
import { updateConfig } from './src/utils/config.js';
import smsRoutes from './src/routes/sms.js';
import paymentRoutes from './src/routes/payment.js';
import verifyRoutes from './src/routes/verify.js';
import './src/config/firebase.js'; // Initialize Firebase

dotenv.config();
const { OPENAI_API_KEY, PORT = 9000 } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key.');
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

// Payment API routes
app.use('/api/payment', paymentRoutes);

// Phone Verification routes
app.use('/api/verify', verifyRoutes);

// 2. INCOMING CALL - Pass Caller Number to WebSocket
app.all('/incoming-call', async (req, res) => {
    const callerNumber = req.body.From || "Unknown";
    const callSid = req.body.CallSid;
    const to = req.body.To || "Unknown";

    console.log(`📞 Incoming call from: ${callerNumber} to ${to}`);
    console.log(`🆔 CallSid: ${callSid}`);

    // Create Call Log in DB
    try {
        await createCallLog({ callSid, from: callerNumber, to });
    } catch (dbError) {
        console.error("❌ Failed to create call log:", dbError);
    }

    if (callSid) {
        client.calls(callSid).recordings.create(
            {
                recordingChannels: 'dual',
                recordingStatusCallbackEvent: ['completed'],
                recordingStatusCallback: `https://${req.headers.host}/recording-complete`
            }

        )
            .then(rec => console.log(`⏺️ Dual-channel recording started: ${rec.sid}`))
            .catch(err => console.error("❌ Recording failed:", err));
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
    console.log("📨 /recording-complete endpoint hit");
    try {
        const { CallSid, RecordingUrl, RecordingDuration } = req.body;
        await updateCallLog({
            callSid: CallSid,
            recordingUrl: RecordingUrl,
            duration: RecordingDuration
        });
        res.sendStatus(200);
    } catch (error) {
        console.error("❌ Error in /recording-complete route:", error);
        res.sendStatus(500);
    }
});



// Configuration Update Endpoint
app.post('/update-config', async (req, res) => {
    console.log("⚙️ /update-config endpoint hit");
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
            console.error("Server Error in /update-config:", error);
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
    console.log('Client connected');

    // --- STATE VARIABLES ---
    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    // Default Persona (will be updated on 'start')
    let currentPersona = null;
    let openAiWs = null;

    // --- HELPER: INTERRUPTION HANDLING ---
    // When you talk, this function truncates the AI's audio immediately
    const handleSpeechStartedEvent = () => {
        if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
            const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;

            console.log(`🚧 Interruption detected. Cancelling AI audio after ${elapsedTime}ms`);

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
            const callerPhone = data.start.customParameters?.caller;
            console.log("📞 Caller Phone Identified:", callerPhone);

            // Ask Dispatcher for Config
            currentPersona = getPersonaByNumber(callerPhone);
            console.log(`✅ Loaded Persona: ${currentPersona.name}`);

            // Connect to OpenAI with specific config
            connectToOpenAI(currentPersona);
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
                    output_modalities: ['audio',],
                    audio: {
                        input: { format: { type: 'audio/pcmu' }, turn_detection: { type: 'server_vad' } },
                        output: {
                            format: {
                                type: 'audio/pcmu'
                            },
                            voice: persona.voice,
                            speed: persona.speed,
                        },
                    },
                    instructions: persona.instructions,
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
            console.log(`🔓 Connected to OpenAI for ${persona.name}`);
            setTimeout(initializeSession, 100);
        });

        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                // DEBUG: Print EVERY event type we get
                // console.log("Received event:", response.type);

                // HANDLE OPENAI ERRORS
                if (response.type === 'error') {
                    console.error("❌ OpenAI Error Event:", JSON.stringify(response.error, null, 2));
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
                    console.log(`👤 USER: ${userText}`);
                }
                // console.log(response);

                // 4. BOT RESPONSE (What AI said)
                if (response.type === 'response.output_audio_transcript.done') {
                    const botText = response.transcript.trim();
                    console.log(`🤖 BOT: ${botText}`);
                }

            } catch (err) {
                console.error("Error processing OpenAI message:", err);
            }
        });

        openAiWs.on('close', () => console.log('OpenAI Closed'));
        openAiWs.on('error', (err) => console.error("OpenAI Error:", err));
    };

    connection.on('close', () => {
        if (openAiWs && openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
        console.log('Client disconnected');
    });
});

server.listen(PORT, () => console.log(`Server listening on ${PORT}`));