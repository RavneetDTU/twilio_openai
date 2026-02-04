import express from 'express';
import http from 'http';
import WebSocket, { WebSocketServer } from "ws";
import dotenv from 'dotenv';
import bodyParser from 'body-parser';
import { log } from 'console';

// Load env variables
dotenv.config();

const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Constants
const BILLYS_PROMPT = `You are a receptionist at Billy's Steakhouse. Start by saying: "Hello! Welcome to Billy's Steakhouse."`;

const RYANS_PROMPT = `You are a receptionist at Ryan's Steakhouse. Start by saying: "Hey there! Welcome to Ryan's Steakhouse."`;

const VOICE = 'alloy';
const TEMPERATURE = 0.8;
const PORT = process.env.PORT || 8000;

const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created',
    'session.updated'
];

const SHOW_TIMING_MATH = false;

// Root route
app.get('/', (req, res) => {
    res.json({ message: 'Twilio Media Stream Server is running!' });
});

// Incoming call route (Twilio webhook)
// Incoming call route
app.all('/incoming-call', (req, res) => {
    const callerNumber = req.body.From || "Unknown";
    console.log(`📞 Incoming call from: ${callerNumber}`);

    // ⚡ TRICK: We add "?caller=${callerNumber}" to the URL
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
        <Connect>
            <Stream url="wss://${req.headers.host}/media-stream">
            <Parameter name="caller" value="${callerNumber}" />
            </Stream>
        </Connect>
        </Response>`;

    console.log("📜 Sending TwiML to Twilio:", twimlResponse);
    res.type('text/xml').send(twimlResponse);
});

// Handle WebSocket upgrade
server.on('upgrade', (req, socket, head) => {
    console.log("🔍 DEBUG: Raw Websocket URL:", req.url);
    if (req.url.startsWith('/media-stream')) {
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    } else {
        console.log("❌ Connection Rejected: URL didn't match");
        socket.destroy();
    }
});

// WebSocket logic
wss.on('connection', (connection, req) => {
    console.log('Client connected');


    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;
    let currentSystemMessage = BILLYS_PROMPT;

    const openAiWs = new WebSocket(
        `wss://api.openai.com/v1/realtime?model=gpt-realtime&temperature=${TEMPERATURE}`,
        {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
            },
        }
    );

    const initializeSession = () => {
        const sessionUpdate = {
            type: 'session.update',
            session: {
                type: 'realtime',
                model: 'gpt-realtime',
                output_modalities: ['audio'],
                audio: {
                    input: {
                        format: { type: 'audio/pcmu' },
                        turn_detection: { type: 'server_vad' },
                    },
                    output: {
                        format: { type: 'audio/pcmu' },
                        voice: VOICE,
                    },
                },
                instructions: currentSystemMessage,
            },
        };
        openAiWs.send(JSON.stringify(sessionUpdate));
    };

    const handleSpeechStartedEvent = () => {
        if (markQueue.length && responseStartTimestampTwilio != null) {
            const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
            if (lastAssistantItem) {
                openAiWs.send(JSON.stringify({
                    type: 'conversation.item.truncate',
                    item_id: lastAssistantItem,
                    content_index: 0,
                    audio_end_ms: elapsedTime,
                }));
            }
            connection.send(JSON.stringify({ event: 'clear', streamSid }));
            markQueue = [];
            lastAssistantItem = null;
            responseStartTimestampTwilio = null;
        }
    };

    const sendMark = () => {
        if (!streamSid) return;
        connection.send(JSON.stringify({
            event: 'mark',
            streamSid,
            mark: { name: 'responsePart' },
        }));
        markQueue.push('responsePart');
    };

    openAiWs.on('open', () => {
        console.log('Connected to OpenAI Realtime API');
        setTimeout(initializeSession, 100);
    });

    openAiWs.on('message', (data) => {
        const response = JSON.parse(data);
        if (LOG_EVENT_TYPES.includes(response.type)) {
            console.log('OpenAI Event:', response.type);
        }
        if (response.type === 'response.output_audio.delta') {
            connection.send(JSON.stringify({
                event: 'media',
                streamSid,
                media: { payload: response.delta },
            }));
            if (!responseStartTimestampTwilio) {
                responseStartTimestampTwilio = latestMediaTimestamp;
            }
            if (response.item_id) {
                lastAssistantItem = response.item_id;
            }
            sendMark();
        }
        if (response.type === 'input_audio_buffer.speech_started') {
            handleSpeechStartedEvent();
        }
    });

    connection.on('message', (message) => {
        const data = JSON.parse(message);
        // console.log("🔍 DEBUG: Received message from Twilio:", data);

        if (data.event === 'start') {
            streamSid = data.start.streamSid;
            latestMediaTimestamp = 0;
            responseStartTimestampTwilio = null;

            const callerPhone = data.start.customParameters?.caller;
            console.log("📞 Caller Phone from Twilio:", callerPhone);

            // 🎯 Decide AI persona HERE
            if (callerPhone === '+918930276263' || callerPhone === '+918319377879') {
                console.log("✅ Match: Billy's Persona");
                currentSystemMessage = BILLYS_PROMPT;
            }
            else if (
                callerPhone === '+918950394085'
            ) {
                console.log("✅ Match: Ryan's Persona");
                currentSystemMessage = RYANS_PROMPT;
            }
            else {
                console.log("⚠️ Unknown Caller: Defaulting to Billy's");
                currentSystemMessage = BILLYS_PROMPT;
            }
        }

        if (data.event === 'media') {
            latestMediaTimestamp = data.media.timestamp;
            if (openAiWs.readyState === WebSocket.OPEN) {
                openAiWs.send(JSON.stringify({
                    type: 'input_audio_buffer.append',
                    audio: data.media.payload,
                }));
            }
        }

        if (data.event === 'mark') {
            markQueue.shift();
        }
    });


    connection.on('close', () => {
        if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
        console.log('Client disconnected');
    });

    openAiWs.on('close', () => {
        console.log('OpenAI WebSocket closed');
    });
    openAiWs.on('error', console.error);
});

// Start server
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
