# Jarvis Calling — AI Voice Booking Backend

A production-ready Node.js backend that connects **Twilio Media Streams** with the **OpenAI Realtime API** to deliver real-time AI voice assistants for restaurant reservation booking. The system handles the full post-call pipeline: dual-channel recording, Whisper transcription, GPT-4 booking extraction, SMS payment links via Twilio, and PayFast payment processing — all persisted to Firebase Firestore.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Environment Variables](#environment-variables)
- [Getting Started](#getting-started)
- [API Reference](#api-reference)
- [Code Reference](#code-reference)

---

## Architecture Overview

```
Incoming Call (Twilio)
       │
       ▼
POST /incoming-call          ← Twilio webhook; starts dual-channel recording
       │
       ▼
WebSocket /media-stream      ← Raw μ-law audio stream from Twilio
       │
  Dispatcher                 ← Maps caller number → restaurant persona
       │
       ▼
OpenAI Realtime API (WSS)    ← GPT-4o Realtime; server-side VAD + TTS
       │
       ▼
POST /recording-complete     ← Twilio callback when recording is ready
       │
  Download → Transcribe      ← Twilio MP3 → OpenAI Whisper
       │
  GPT-4 Extraction           ← Structured booking JSON from transcript
       │
  Reservation API + SMS      ← External dashboard sync + Twilio SMS
       │
  PayFast ITN                ← Payment confirmation & Firestore update
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (ESM) |
| Framework | Express 5 |
| Real-time Audio | WebSocket (`ws`) |
| Voice AI | OpenAI Realtime API (`gpt-realtime-mini`) |
| Transcription | OpenAI Whisper (`whisper-1`) |
| Booking Extraction | OpenAI GPT-4 |
| Telephony | Twilio (Calls, Recordings, SMS, Lookup) |
| Database | Firebase Firestore (via `firebase-admin`) |
| Payment Gateway | PayFast (ITN / webhook) |
| Logging | Winston + `winston-daily-rotate-file` |
| Process Manager | Nodemon (dev) |

---

## Project Structure

```
.
├── server.js                   # Main entry point — Express + WebSocket server
├── app.js                      # Legacy prototype (not used in production)
├── src/
│   ├── dispatcher.js           # Maps caller phone number → AI persona
│   ├── bot_models/             # AI persona configurations
│   │   ├── billys.js
│   │   ├── ryans.js
│   │   ├── bjorns.js
│   │   └── wine_tasting.js
│   ├── prompts/                # System prompt builders + config store
│   │   ├── billys_prompt.js
│   │   ├── ryans_prompt.js
│   │   ├── bjorns_prompt.js
│   │   ├── wine_tasting_prompt.js
│   │   └── prompts.json        # Restaurant settings, hours, question flows
│   ├── config/
│   │   └── firebase.js         # Firebase Admin SDK initialization
│   ├── models/
│   │   └── CallLog.js          # Mongoose schema reference (Firestore is active DB)
│   ├── routes/
│   │   ├── booking.js          # POST /api/booking/manual/:restaurantId
│   │   ├── sms.js              # POST /api/sms/send, GET /api/sms/status/:callSid
│   │   ├── payment.js          # GET /api/payment/:paymentId (+ optional splitPayment)
│   │   ├── payfastCheckoutPage.js  # GET /payment/:paymentId — PayFast form + split setup
│   │   ├── payfastNotify.js    # POST /api/payfast/notify, GET /api/payfast/payments/:restaurantId
│   │   └── verify.js           # POST /api/verify/phone
│   ├── services/
│   │   ├── callService.js      # Core call lifecycle: create/update CallLog, transcribe, extract, notify
│   │   ├── smsService.js       # Twilio SMS — payment links + automated post-call SMS
│   │   ├── manualBookingService.js  # Manual booking creation + SMS dispatch
│   │   ├── payfastCheckoutService.js  # Checkout signature + Direct Request split setup
│   │   └── payfastService.js   # PayFast ITN signature, domain, amount validation
│   └── utils/
│       ├── config.js           # Read/write prompts.json — restaurant settings & question flow
│       ├── download.js         # Stream Twilio recording MP3 to local disk
│       ├── extraction.js       # GPT-4 booking data extraction from transcript
│       ├── transcription.js    # OpenAI Whisper audio-to-text
│       └── logger.js           # Winston logger with daily log rotation
├── logs/                       # Auto-created; daily rotating call logs (7-day retention)
├── recordings/                 # Auto-created; downloaded Twilio MP3 recordings
└── prompts.json                # See src/prompts/prompts.json
```

---

## Environment Variables

Create a `.env` file in the project root:

```env
# OpenAI
OPENAI_API_KEY=sk-...

# Twilio
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1...

# PayFast (Booki primary merchant — checkout + ITN)
PAYFAST_MERCHANT_ID=10000100
PAYFAST_MERCHANT_KEY=...
PAYFAST_PASSPHRASE=your_passphrase
PAYFAST_SANDBOX=false
# Optional override for ITN notify_url on checkout forms
# PAYFAST_NOTIFY_URL=https://phone.booki.co.za/api/payfast/notify

# Firebase (fallback if JSON file is absent)
FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}

# SMS payment links → {PAYMENT_FRONTEND_URL}/payment/{paymentId}
# Live checkout is mybookip: https://github.com/RavneetDTU/mybookip
PAYMENT_FRONTEND_URL=https://payment.booki.co.za

# Server
PORT=5014
```

> Firebase credentials are loaded from `twilio-openai-calls-firebase-adminsdk-fbsvc-8a3ff10c65.json` at project root. The `FIREBASE_SERVICE_ACCOUNT` env var is a fallback for environments where the file cannot be committed.

> **Restaurant PayFast merchant** is not in `.env`. It is saved from the mybooki dashboard (**Settings → Bank Details**) via `POST /api/update-config` into Firestore `tenants/{restaurantId}.settings.payfastMerchantId` (default split `payfastSplitPercentage: 80`).

---

## PayFast Split Payments (Direct Request)

When a customer pays (e.g. R100) and the restaurant has a valid `payfastMerchantId`:

| Share | Destination |
|---|---|
| **80%** (default) | Restaurant PayFast merchant |
| **~20%** | Booki primary merchant (`.env` `PAYFAST_*`) |

Split is applied **only at checkout** by posting PayFast’s `setup` field (excluded from the MD5 signature). ITN (`POST /api/payfast/notify`) is unchanged. If no restaurant merchant id is configured, checkout posts **no** `setup` (full amount to Booki).

Enable **Split Payments** on the Booki (primary) PayFast account before going live.

**Three apps:**

| App | Repo / host | Role |
|---|---|---|
| Voice / APIs / ITN | `twilio_openai` → `https://phone.booki.co.za` | Calls, SMS, `GET /api/payment/:id` (`splitPayment`), ITN |
| Restaurant dashboard | `mybooki` | Settings → Bank Details (store restaurant merchant in Firestore). `/payments` is history only |
| Customer checkout | [mybookip](https://github.com/RavneetDTU/mybookip) → `https://payment.booki.co.za` | SMS pay page; posts PayFast `setup` when API returns `splitPayment` |

Flow:

```text
AI booking on phone.booki.co.za
  → SMS: https://payment.booki.co.za/payment/{paymentId}
  → mybookip GET https://phone.booki.co.za/api/payment/{id}
  → PayFast process (optional setup)
  → ITN POST https://phone.booki.co.za/api/payfast/notify
```

---

## Getting Started

```bash
# Install dependencies
npm install

# Start development server (nodemon)
npm start
```

The server starts on the port defined in `PORT` (default: `9000`).

**Twilio Configuration** — set these webhooks in your Twilio console:

| Event | URL |
|---|---|
| Incoming Call | `https://<your-domain>/incoming-call` |
| Recording Status | `https://<your-domain>/recording-complete` |
| PayFast Notify URL | `https://<your-domain>/api/payfast/notify` |

---

## API Reference

### Webhooks (Twilio)

| Method | Path | Description |
|---|---|---|
| `ALL` | `/incoming-call` | Twilio webhook; returns TwiML to start media stream + recording |
| `POST` | `/recording-complete` | Twilio recording callback; triggers download → transcription → extraction pipeline |

### Restaurant Config

| Method | Path | Body / Params | Description |
|---|---|---|---|
| `POST` | `/api/update-config` | `{ restaurantId, settings?, operatingHours?, questionFlow? }` | Merge-update restaurant settings |
| `GET` | `/api/restaurant/:id/details` | `:id` = restaurant ID | Fetch full restaurant config |
| `POST` | `/api/question/add` | `{ restaurantId, question: { title, botMessage, isRequired, instructions? } }` | Add question to AI flow |
| `DELETE` | `/api/question/delete` | `{ restaurantId, questionId }` | Remove question by ID |

### Booking

| Method | Path | Body / Params | Description |
|---|---|---|---|
| `POST` | `/api/booking/manual/:restaurantId` | `{ name, phoneNo, guests, date?, time?, allergy?, notes? }` | Create manual booking + send SMS |
| `GET` | `/api/payment/:paymentId` | `:paymentId` = UUID | Booking JSON for payment UIs; includes `splitPayment` when restaurant merchant is set |

### SMS

| Method | Path | Body / Params | Description |
|---|---|---|---|
| `POST` | `/api/sms/send` | `{ callSid }` | Manually resend payment SMS for a call |
| `GET` | `/api/sms/status/:callSid` | `:callSid` | Get SMS delivery status for a call |

### Payments (PayFast)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/payfast/notify` | PayFast ITN endpoint — validates & records payment |
| `GET` | `/api/payfast/payments/:restaurantId` | List all payments for a restaurant |

Customer checkout is **not** this server. SMS uses `PAYMENT_FRONTEND_URL` → [mybookip](https://github.com/RavneetDTU/mybookip) (`https://payment.booki.co.za/payment/{id}`).
### Utilities

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/api/verify/phone` | `{ phoneNumber }` | Validate phone number via Twilio Lookup v2 |

---

## Code Reference

### `server.js`

Entry point. Bootstraps Express, HTTP server, and WebSocket server. Registers all route groups and handles the real-time call flow.

| Function / Handler | Input | Output | Purpose |
|---|---|---|---|
| `POST /incoming-call` | Twilio webhook body (`From`, `CallSid`, `To`) | TwiML XML response | Creates CallLog, starts dual-channel recording, returns WebSocket stream URL |
| `POST /recording-complete` | `{ CallSid, RecordingUrl, RecordingDuration }` | HTTP 200 | Triggers `updateCallLog` post-call pipeline |
| `wss.on('connection')` | WebSocket upgrade from Twilio | — | Manages full call session state |
| `handleSpeechStartedEvent()` | — (reads session state) | Sends truncation + clear to Twilio | Cancels AI audio mid-speech on user interruption |
| `sendMark()` | — (reads `streamSid`) | Sends mark event to Twilio | Keeps audio playback timing in sync |
| `connectToOpenAI(persona)` | Persona config object | Opens OpenAI WebSocket | Initializes OpenAI Realtime session with persona instructions and voice |

---

### `src/dispatcher.js`

| Function | Input | Output | Purpose |
|---|---|---|---|
| `getPersonaByNumber(callerNumber)` | `string` — E.164 phone number | Persona config object | Maps caller number to the correct restaurant AI persona; defaults to Billy's |

---

### `src/config/firebase.js`

Initializes Firebase Admin SDK on import. Exports `db` (Firestore instance).

| Export | Purpose |
|---|---|
| `db` | Active Firestore instance used across all services |

---

### `src/services/callService.js`

Core post-call pipeline. Handles the full lifecycle from call start to reservation sync.

| Function | Input | Output | Purpose |
|---|---|---|---|
| `createCallLog({ callSid, from, to })` | Call identifiers | Saved Firestore document | Creates initial CallLog at call start; resolves restaurant from caller number |
| `updateCallLog({ callSid, recordingUrl, duration })` | Recording details | Updated Firestore document | Downloads MP3 → transcribes → extracts booking → classifies → syncs to API + sends SMS |
| `getRestaurantInfo(callerPhone)` *(internal)* | E.164 phone string | `{ id, name }` | Resolves restaurant ID/name from `RESTAURANT_MAP` |
| `classifyBooking(bookingData)` *(internal)* | Extracted booking object | `'complete'` \| `'failed'` | Marks booking complete only if name + phone + date are all present |
| `sendReservationToApi(restaurantId, paymentId, bookingData, transcript)` *(internal)* | Booking details | API response object | POSTs completed booking to external reservation dashboard |
| `sendFailedBookingToApi(restaurantId, bookingData, transcript)` *(internal)* | Partial booking data | API response object | POSTs incomplete bookings to failed-bookings endpoint with "Not Provided" fallbacks |

---

### `src/services/smsService.js`

Class `SmsService` — singleton export. Handles all outbound SMS via Twilio.

| Method | Input | Output | Purpose |
|---|---|---|---|
| `formatPhoneNumber(phoneNumber, defaultCountryCode)` | Raw phone string | E.164 formatted string | Normalizes phone numbers; handles India (`+91`) and South Africa (`+27`) |
| `formatTo12Hour(timeStr)` | `"HH:mm"` or AM/PM string | `"h:mm AM/PM"` string | Converts 24-hour time to 12-hour format for SMS readability |
| `sendPaymentSms({ customerName, customerPhone, numberOfGuests, bookingDate, bookingTime, paymentId, restaurantName, bookingAmount })` | Booking + payment details | `{ success, sid, status, sentAt }` | Sends SMS with booking summary and optional payment link |
| `sendAutomatedSms(bookingData, paymentId, restaurantName)` | Extracted booking object + paymentId | `{ success, sid, status, sentAt }` | Post-call automation wrapper around `sendPaymentSms` |

---

### `src/services/manualBookingService.js`

Class `ManualBookingService` — singleton export.

| Method | Input | Output | Purpose |
|---|---|---|---|
| `createManualBooking(restaurantId, bookingData)` | `restaurantId` string + `{ name, phoneNo, guests, date?, time?, allergy?, notes? }` | `{ success, paymentId, smsStatus, smsDetails }` | Creates Firestore record, pushes to reservation API, sends SMS payment link |

---

### `src/services/payfastService.js`

Stateless PayFast ITN validation helpers.

| Function | Input | Output | Purpose |
|---|---|---|---|
| `validateSignature(data, passphrase)` | PayFast POST body + passphrase | `boolean` | MD5 signature verification per PayFast spec |
| `validatePayfastDomain(req)` | Express request object | `Promise<boolean>` | DNS-resolves PayFast domains; validates incoming request IP |
| `confirmWithPayfast(data)` | PayFast POST body | `Promise<boolean>` | Server-to-server confirmation; expects `"VALID"` response from PayFast |
| `validateAmount(receivedAmount, expectedAmount)` | Two numeric values | `boolean` | Compares amounts with ±0.01 tolerance for floating-point safety |

---

### `src/utils/config.js`

Reads and writes `src/prompts/prompts.json` — the live restaurant configuration store.

| Function | Input | Output | Purpose |
|---|---|---|---|
| `updateConfig(updates)` | `{ restaurantId, settings?, operatingHours?, questionFlow? }` | Updated restaurant object | Smart-merges partial updates into the config file |
| `getRestaurantDetails(restaurantId)` | `string` | Full restaurant config object | Reads and returns a single restaurant's config |
| `addQuestion(restaurantId, newQuestion)` | `restaurantId` + `{ title, botMessage, isRequired, instructions? }` | Updated restaurant object | Inserts new question at second-to-last position; auto-generates `id` and re-orders |
| `deleteQuestion(restaurantId, questionId)` | `restaurantId` + `questionId` | Updated restaurant object | Removes question by `id`; re-numbers remaining questions |
| `normaliseOrders(questionFlow)` *(internal)* | Question array (mutable) | — | Re-assigns `order` values as 1…N after any insert or delete |

---

### `src/utils/extraction.js`

| Function | Input | Output | Purpose |
|---|---|---|---|
| `extractBookingData(transcriptText)` | Raw conversation transcript string | `Promise<Object\|null>` | Sends transcript to GPT-4; returns structured `{ name, date, time, guests, phoneNo, allergy, notes }` |

---

### `src/utils/transcription.js`

| Function | Input | Output | Purpose |
|---|---|---|---|
| `transcribeAudio(filePath)` | Absolute path to local MP3 file | `Promise<string\|null>` | Sends audio file to OpenAI Whisper; returns transcript text |

---

### `src/utils/download.js`

| Function | Input | Output | Purpose |
|---|---|---|---|
| `downloadFile(url, outputPath)` | Twilio recording URL + local save path | `Promise<string>` — resolves with `outputPath` | Streams Twilio MP3 to disk with Basic Auth; appends `.mp3` extension if missing |

---

### `src/utils/logger.js`

Singleton Winston logger. Writes timestamped logs to console and daily-rotating files under `logs/call-YYYY-MM-DD.log` (7-day retention).

---

### `src/bot_models/`

Each file exports a persona config object consumed by `dispatcher.js` and `server.js`.

| File | Persona | Voice | Model |
|---|---|---|---|
| `billys.js` | Billy's Steakhouse | `cedar` (male) | `gpt-realtime-mini` |
| `ryans.js` | Ryan's Steakhouse | female voice | `gpt-realtime-mini` |
| `bjorns.js` | Bjorn's Steakhouse | female voice | `gpt-realtime-mini` |
| `wine_tasting.js` | Wine Tasting Terrance | — | `gpt-realtime-mini` |

Each persona object shape: `{ id, name, model, voice, temperature, get instructions() }`.

---

### `src/prompts/`

| File | Purpose |
|---|---|
| `billys_prompt.js` | Exports `getBillysPrompt()` — builds dynamic system prompt from `prompts.json` config |
| `ryans_prompt.js` | Same pattern for Ryan's Steakhouse |
| `bjorns_prompt.js` | Same pattern for Bjorn's Steakhouse |
| `wine_tasting_prompt.js` | Same pattern for Wine Tasting Terrance |
| `prompts.json` | Source-of-truth config: restaurant name, operating hours, deposit amount, question flow per restaurant |

---

### `src/routes/` 

Thin Express routers — delegate all business logic to service layer.

| File | Endpoints | Delegates to |
|---|---|---|
| `booking.js` | `POST /api/booking/manual/:restaurantId` | `manualBookingService.createManualBooking` |
| `sms.js` | `POST /api/sms/send`, `GET /api/sms/status/:callSid` | `smsService`, Firestore |
| `payment.js` | `GET /api/payment/:paymentId` | Firestore (`callLogs`, `manualBookings`); optional `splitPayment` |
| `payfastCheckoutPage.js` | `GET /payment/:paymentId`, success/fail pages | `payfastCheckoutService`, tenant settings |
| `payfastNotify.js` | `POST /api/payfast/notify`, `GET /api/payfast/payments/:restaurantId` | `payfastService`, Firestore |
| `verify.js` | `POST /api/verify/phone` | Twilio Lookup v2 |

---

## Firestore Collections

| Collection | Description |
|---|---|
| `callLogs` | One document per call; keyed by `callSid` |
| `manualBookings` | One document per manual booking; keyed by `paymentId` |
| `payments` | One document per PayFast ITN; keyed by `paymentId` |
