import logger from '../../utils/logger.js';
import { accounts } from './accounts.js';
import { syncAccount } from './processor.js';

let timer = null;

export function startEmailWorker() {
    if (timer) return;
    const interval = Number(process.env.EMAIL_SYNC_INTERVAL_MS || 60000);
    timer = setInterval(() => {
        syncConnected().catch((error) => logger.error(`Email worker failed: ${error.message}`));
    }, interval);
    if (typeof timer.unref === 'function') timer.unref();
}

async function syncConnected() {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.EMAIL_TOKEN_KEY) return;
    const snap = await accounts().where('status', '==', 'connected').limit(20).get();
    for (const doc of snap.docs) {
        try {
            await syncAccount(doc.id);
        } catch (error) {
            logger.error(`Email sync failed for ${doc.id}: ${error.message}`);
            await doc.ref.set({ lastError: 'The last Gmail sync failed.' }, { merge: true });
        }
    }
}
