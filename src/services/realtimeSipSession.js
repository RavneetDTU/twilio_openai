// src/services/realtimeSipSession.js
// =============================================================================
// OPENAI REALTIME SIP — SIDEBAND CONTROL SESSION
// =============================================================================
// Audio flows Twilio ↔ OpenAI over RTP. This WebSocket is control-only (session
// config, transcripts, tool calls). Greeting is deferred until the caller has
// actually joined the Conference so setup happens during ringback, not silence.
// =============================================================================

import WebSocket from 'ws';
import Twilio from 'twilio';
import logger from '../utils/logger.js';
import { getAvailableCapacityForDate } from './capacityService.js';
import { getRestaurantDetails } from '../utils/config.js';

const { OPENAI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;

const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const CLOSING_PHRASES = [
    'look forward to welcoming you',
    'look forward to speaking with you',
    'have a wonderful day',
];

const CHECK_CAPACITY_TOOL = {
    type: 'function',
    name: 'check_capacity_for_date',
    description: 'Check how many seats are available at the restaurant on a specific date. Call this BEFORE confirming any reservation.',
    parameters: {
        type: 'object',
        properties: {
            date: {
                type: 'string',
                description: 'The booking date in YYYY-MM-DD format (e.g. "2026-05-22")',
            },
        },
        required: ['date'],
    },
};

const HANGUP_DELAY_MS = 11000;
const SESSION_READY_TIMEOUT_MS = 5000;

/** Active SIP sideband sessions keyed by Twilio CallSid (Conference friendly name). */
export const activeSipSessions = new Map();

export class RealtimeSipSession {
    /**
     * @param {string} callId - OpenAI's call_id for this SIP session.
     * @param {string} callerCallSid - Twilio CallSid of the caller's leg (used for hangup).
     * @param {Object} persona - Tenant persona resolved via dispatcher.getTenantByNumber().
     */
    constructor(callId, callerCallSid, persona) {
        this.callId = callId;
        this.callerCallSid = callerCallSid;
        this.persona = persona;
        this.ws = null;
        this.isClosed = false;
        this.bookingCompleted = false;
        this.greetingSent = false;
        this.sessionConfigured = false;
        this.sessionUpdateAcked = false;
        this.vadEnabled = false;
        this._readyResolve = null;
        this._readyReject = null;
        this._readySettled = false;
        this._sessionUpdateTimer = null;
    }

    /**
     * Opens the sideband socket, sends session.update, and resolves when the
     * session is configured (session.updated) so /incoming-call can answer.
     * Does NOT send the greeting yet — call sendGreeting() after the caller joins.
     * @returns {Promise<RealtimeSipSession>}
     */
    connectAndConfigure() {
        return new Promise((resolve, reject) => {
            this._readyResolve = resolve;
            this._readyReject = reject;

            const wsUrl = `wss://api.openai.com/v1/realtime?call_id=${this.callId}`;

            this.ws = new WebSocket(wsUrl, {
                headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
                perMessageDeflate: false,
            });

            this.ws.on('open', () => {
                logger.info(`🔓 [SIP] Sideband connected for ${this.persona.name} | Call: ${this.callId}`);
                // Demo pattern: session.update then immediately treat as ready so
                // /incoming-call can answer — do not wait for session.updated RTT.
                this.configureSession();
                this._markConfigured();
            });

            this.ws.on('message', (data) => {
                try {
                    const event = JSON.parse(data);
                    this.handleServerEvent(event);
                } catch (err) {
                    logger.error(`[SIP] Error processing OpenAI sideband message: ${err.message}`);
                }
            });

            this.ws.on('close', () => {
                logger.info(`[SIP] Sideband closed | Call: ${this.callId}`);
                activeSipSessions.delete(this.callerCallSid);
                if (!this._readySettled) {
                    this._settleReady(null, new Error('Sideband closed before session was ready'));
                }
            });

            this.ws.on('error', (err) => {
                logger.error(`[SIP] Sideband error | Call: ${this.callId} | ${err.message}`);
                if (!this._readySettled) {
                    this._settleReady(null, err);
                }
            });
        });
    }

    configureSession() {
        // VAD stays off until the greeting finishes. Conference join / RTP settle
        // noise otherwise auto-starts a response and our response.create fails with
        // conversation_already_has_active_response (seen on CA6842375b...).
        this.send({
            type: 'session.update',
            session: {
                type: 'realtime',
                model: this.persona.model,
                output_modalities: ['audio'],
                instructions: this.persona.instructions,
                audio: {
                    input: {
                        turn_detection: null,
                    },
                    output: {
                        voice: this.persona.voice,
                        speed: this.persona.speed,
                    },
                },
                tools: [CHECK_CAPACITY_TOOL],
                tool_choice: 'auto',
            },
        });

        // Warn only — readiness is already signaled on socket open.
        this._sessionUpdateTimer = setTimeout(() => {
            if (!this.sessionUpdateAcked) {
                logger.warn(
                    `[SIP] No session.updated within ${SESSION_READY_TIMEOUT_MS}ms for ${this.callId} — tools may be missing.`
                );
            }
        }, SESSION_READY_TIMEOUT_MS);
    }

    /**
     * Speaks the tenant greeting. Call when answering / as the customer joins —
     * not during ringback setup.
     */
    sendGreeting() {
        if (this.greetingSent || this.isClosed) return;
        this.greetingSent = true;

        const greeting = this.persona.greetingMessage
            || `Hello! Welcome to ${this.persona.name}. How can I help you today?`;

        logger.info(`🎙️ [SIP] Sending greeting for ${this.callerCallSid}`);
        this.send({
            type: 'response.create',
            response: {
                instructions: `Greet the caller by saying exactly this, word for word, and nothing else: "${greeting}"`,
            },
        });

        // Safety: never leave the call without VAD if response.done is missed.
        setTimeout(() => this.enableVadAfterGreeting(), 10000);
    }

    enableVadAfterGreeting() {
        if (this.vadEnabled || this.isClosed) return;
        this.vadEnabled = true;
        logger.info(`[SIP] Enabling server_vad after greeting for ${this.callId}`);
        this.send({
            type: 'session.update',
            session: {
                type: 'realtime',
                audio: {
                    input: {
                        turn_detection: { type: 'server_vad' },
                    },
                },
            },
        });
    }

    _markConfigured() {
        if (this.sessionConfigured) return;
        this.sessionConfigured = true;
        if (this._sessionUpdateTimer) {
            clearTimeout(this._sessionUpdateTimer);
            this._sessionUpdateTimer = null;
        }
        activeSipSessions.set(this.callerCallSid, this);
        this._settleReady(this, null);
    }

    _settleReady(session, error) {
        if (this._readySettled) return;
        this._readySettled = true;
        if (error) {
            this._readyReject?.(error);
        } else {
            this._readyResolve?.(session);
        }
    }

    handleServerEvent(response) {
        if (response.type === 'error') {
            const code = response.error?.code;
            // If a race still creates a conflicting response.create, keep the in-flight
            // audio (usually already the greeting) and enable VAD when it finishes.
            if (code === 'conversation_already_has_active_response') {
                logger.warn(`[SIP] Greeting create raced an in-flight response for ${this.callId} — keeping active response`);
                this.greetingSent = true;
                return;
            }
            logger.error(`❌ [SIP] OpenAI Error Event: ${JSON.stringify(response.error, null, 2)}`);
            if (!this.sessionConfigured) {
                this._settleReady(null, new Error(response.error?.message || 'session.update failed'));
            }
            return;
        }

        if (response.type === 'session.updated') {
            this.sessionUpdateAcked = true;
            if (this._sessionUpdateTimer) {
                clearTimeout(this._sessionUpdateTimer);
                this._sessionUpdateTimer = null;
            }
            logger.info(`[SIP] Session configured for call ${this.callId}`);
            if (!this.sessionConfigured) {
                this._markConfigured();
            }
            return;
        }

        if (response.type === 'response.done' && this.greetingSent && !this.vadEnabled) {
            this.enableVadAfterGreeting();
        }

        if (response.type === 'response.function_call_arguments.done' &&
            response.name === 'check_capacity_for_date') {
            this.handleCapacityCheck(response);
            return;
        }

        if (response.type === 'response.output_audio_transcript.done') {
            const botText = (response.transcript || '').trim();
            logger.info(`🤖 [SIP] BOT: ${botText}`);

            const isClosingMessage = CLOSING_PHRASES.some((phrase) => botText.toLowerCase().includes(phrase));

            if (isClosingMessage && !this.bookingCompleted) {
                this.bookingCompleted = true;
                logger.info(`✅ [SIP] Closing phrase detected: "${botText.substring(0, 60)}..." — scheduling call termination in ${HANGUP_DELAY_MS / 1000}s...`);
                setTimeout(() => this.hangupCallerLeg(), HANGUP_DELAY_MS);
            }
        }
    }

    async handleCapacityCheck(response) {
        try {
            const args = JSON.parse(response.arguments);
            const dateStr = args.date;

            const restaurantId = this.persona.restaurantId || this.persona.id;
            const restaurantConfig = await getRestaurantDetails(restaurantId);
            const settings = restaurantConfig?.settings || {};

            const capacity = await getAvailableCapacityForDate(settings, restaurantId, dateStr);

            logger.info(`📊 [SIP Tool] check_capacity_for_date(${dateStr}) → available: ${capacity.available}`);

            this.send({
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
                        fullyBooked: capacity.available === 0,
                    }),
                },
            });

            this.send({ type: 'response.create' });
        } catch (toolErr) {
            logger.error(`❌ [SIP Tool] check_capacity_for_date failed: ${toolErr.message}`);
        }
    }

    async hangupCallerLeg() {
        try {
            await twilioClient.calls(this.callerCallSid).update({ status: 'completed' });
            logger.info(`📵 [SIP] Call ${this.callerCallSid} ended successfully via Twilio REST API.`);
        } catch (hangupErr) {
            logger.error(`❌ [SIP] Failed to end call ${this.callerCallSid}: ${hangupErr.message}`);
        }
    }

    send(event) {
        if (this.isClosed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            logger.warn(`[SIP] Attempted to send on closed/inactive sideband socket | Call: ${this.callId}`);
            return;
        }
        try {
            this.ws.send(JSON.stringify(event));
        } catch (err) {
            logger.error(`[SIP] Error sending sideband event: ${err.message}`);
        }
    }

    close() {
        if (this.isClosed) return;
        this.isClosed = true;
        activeSipSessions.delete(this.callerCallSid);
        if (this._sessionUpdateTimer) {
            clearTimeout(this._sessionUpdateTimer);
            this._sessionUpdateTimer = null;
        }
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.close();
        }
    }
}
