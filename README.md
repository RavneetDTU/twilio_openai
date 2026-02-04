# Twilio OpenAI Voice Bot

AI-powered voice assistant for restaurant booking using Twilio and OpenAI Realtime API. Handles incoming calls, records conversations, transcribes audio, extracts booking information, and sends automated SMS with payment links.

## Features

- 🤖 **AI Voice Assistant** - Real-time conversation using OpenAI Realtime API
- 📞 **Call Handling** - Twilio integration for incoming calls
- ⏺️ **Call Recording** - Dual-channel recording with automatic download
- 📝 **Transcription** - Automatic audio-to-text conversion
- 📊 **Data Extraction** - Extract booking details (name, time, guests, allergies)
- 💬 **SMS Notifications** - Automated SMS with payment links
- 🔥 **Firebase Integration** - Store call logs and booking data
- 🎭 **Multi-Persona Support** - Different AI personalities per restaurant

## Tech Stack

- **Backend**: Node.js, Express
- **AI**: OpenAI Realtime API (GPT-4 Realtime)
- **Telephony**: Twilio Voice & SMS
- **Database**: Firebase Firestore
- **WebSocket**: Real-time audio streaming

## Prerequisites

- Node.js (v14 or higher)
- Twilio account with phone number
- OpenAI API key
- Firebase project with Firestore enabled

## Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd new_twilio_openai
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Create `.env` file**
   ```bash
   # Copy and fill in your credentials
   OPENAI_API_KEY=your_openai_api_key
   TWILIO_ACCOUNT_SID=your_twilio_account_sid
   TWILIO_AUTH_TOKEN=your_twilio_auth_token
   TWILIO_PHONE_NUMBER=your_twilio_phone_number
   PORT=9000
   ```

4. **Add Firebase credentials**
   - Download your Firebase Admin SDK JSON file
   - Place it in the project root
   - Update the filename in `src/config/firebase.js` if needed

5. **Create recordings folder** (optional - auto-created)
   ```bash
   mkdir recordings
   ```

## Configuration

### Restaurant Configuration

Edit `src/prompts/prompts.json` to configure restaurant settings:

```json
{
  "restaurantId": "resto_bjorns_001",
  "name": "Bjorn's Steakhouse",
  "settings": {
    "depositAmount": 750,
    "currency": "rand",
    "timezone": "Africa/Johannesburg"
  },
  "operatingHours": {
    "Monday": { "open": "12:00 PM", "close": "10:00 PM" }
  }
}
```

### Bot Personas

Configure different AI personalities in `src/dispatcher.js` based on caller phone numbers.

## Usage

### Start the Server

```bash
npm start
# or
node server.js
```

Server will run on `http://localhost:9000`

### Configure Twilio Webhook

1. Go to your Twilio Console
2. Select your phone number
3. Under "Voice & Fax", set:
   - **A CALL COMES IN**: `https://your-domain.com/incoming-call`
   - **METHOD**: HTTP POST

### Test the System

1. Call your Twilio phone number
2. The AI assistant will answer and handle the conversation
3. After the call, check:
   - Recording saved in `recordings/` folder
   - Call log in Firebase Firestore
   - SMS sent to customer (if booking data is complete)

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Health check |
| `/incoming-call` | POST | Twilio webhook for incoming calls |
| `/recording-complete` | POST | Twilio webhook for recording completion |
| `/update-config` | POST | Update restaurant configuration |
| `/api/sms/send` | POST | Send manual SMS |
| `/api/sms/status/:messageSid` | GET | Check SMS delivery status |
| `/api/payment/verify` | POST | Verify payment completion |

## Project Structure

```
new_twilio_openai/
├── src/
│   ├── bot_models/          # AI persona configurations
│   ├── config/              # Firebase and app configuration
│   ├── models/              # Data models (CallLog)
│   ├── prompts/             # AI prompts and restaurant config
│   ├── routes/              # API routes (SMS, Payment)
│   ├── services/            # Business logic (Call, SMS)
│   ├── utils/               # Utilities (download, transcription)
│   └── dispatcher.js        # Route calls to correct persona
├── recordings/              # Call recordings (not in git)
├── .env                     # Environment variables (not in git)
├── .gitignore              # Git ignore rules
├── server.js               # Main server file
└── package.json            # Dependencies
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `OPENAI_API_KEY` | OpenAI API key | ✅ Yes |
| `TWILIO_ACCOUNT_SID` | Twilio account SID | ✅ Yes |
| `TWILIO_AUTH_TOKEN` | Twilio auth token | ✅ Yes |
| `TWILIO_PHONE_NUMBER` | Your Twilio phone number | ✅ Yes |
| `PORT` | Server port (default: 9000) | ❌ No |

## Deployment

### Using PM2 (Recommended)

```bash
# Install PM2
npm install -g pm2

# Start application
pm2 start server.js --name twilio-voice-bot

# View logs
pm2 logs twilio-voice-bot

# Restart
pm2 restart twilio-voice-bot

# Stop
pm2 stop twilio-voice-bot
```

### Important Notes

- ⚠️ **Do NOT commit** `.env` file or Firebase credentials to Git
- ⚠️ **Do NOT commit** `recordings/` folder (contains customer data)
- ✅ Ensure your server has a public HTTPS URL for Twilio webhooks
- ✅ Set up SSL certificate (Twilio requires HTTPS)

## Troubleshooting

### Common Issues

**"Cannot find module"**
```bash
npm install
```

**"Missing OpenAI API key"**
- Check `.env` file exists and contains `OPENAI_API_KEY`

**"Firebase connection failed"**
- Verify Firebase credentials JSON file is in project root
- Check file path in `src/config/firebase.js`

**"Recording download failed"**
- Verify Twilio credentials in `.env`
- Check `recordings/` folder has write permissions

**"SMS not sending"**
- Verify `TWILIO_PHONE_NUMBER` in `.env`
- Check Twilio account has SMS capabilities

## Development

### Adding a New Restaurant

1. Create new bot model in `src/bot_models/`
2. Create new prompt in `src/prompts/`
3. Update `src/dispatcher.js` to route calls
4. Update `prompts.json` with restaurant config

### Testing Locally with ngrok

```bash
# Install ngrok
npm install -g ngrok

# Expose local server
ngrok http 9000

# Use the HTTPS URL in Twilio webhook configuration
```

## License

MIT

## Support

For issues or questions, please contact the development team.
