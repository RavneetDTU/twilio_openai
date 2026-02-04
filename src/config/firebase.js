import admin from 'firebase-admin';
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let serviceAccount;

// Try to load from JSON file first (recommended approach)
try {
    const serviceAccountPath = join(__dirname, '../../twilio-openai-calls-firebase-adminsdk-fbsvc-8a3ff10c65.json');
    serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
    console.log('✅ Firebase credentials loaded from JSON file');
} catch (fileError) {
    // Fallback to environment variable
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
            // Remove newlines and extra spaces for proper JSON parsing
            const cleanedJson = process.env.FIREBASE_SERVICE_ACCOUNT.replace(/\r?\n/g, '').trim();
            serviceAccount = JSON.parse(cleanedJson);
            console.log('✅ Firebase credentials loaded from environment variable');
        } catch (parseError) {
            console.error('❌ Failed to parse FIREBASE_SERVICE_ACCOUNT:', parseError.message);
            console.error('Please ensure the JSON is properly formatted on a single line');
            process.exit(1);
        }
    } else {
        console.error('❌ Firebase credentials not found');
        console.error('Please add twilio-openai-calls-firebase-adminsdk-fbsvc-8a3ff10c65.json to project root');
        console.error('OR set FIREBASE_SERVICE_ACCOUNT environment variable');
        process.exit(1);
    }
}

// Initialize Firebase Admin
try {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Firebase Admin initialized successfully');
    console.log(`📦 Project ID: ${serviceAccount.project_id}`);
} catch (error) {
    console.error('❌ Failed to initialize Firebase Admin:', error);
    process.exit(1);
}

// Export Firestore instance
export const db = admin.firestore();

// Configure Firestore settings
db.settings({
    ignoreUndefinedProperties: true
});

export default admin;
