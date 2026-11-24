import { db } from '../../config/firebase.js';
import { decryptSecret, encryptSecret } from './crypto.js';

const ACCOUNTS = 'emailAccounts';
const THREADS = 'emailThreads';
const MESSAGES = 'emailMessages';
const PROCESSED = 'emailProcessedMessages';

export const emailCollections = { ACCOUNTS, THREADS, MESSAGES, PROCESSED };

export function accounts() {
    return db.collection(ACCOUNTS);
}

export function threads() {
    return db.collection(THREADS);
}

export function messages() {
    return db.collection(MESSAGES);
}

export async function getAccount(restaurantId) {
    const snap = await accounts().doc(String(restaurantId)).get();
    if (!snap.exists) return null;
    return { id: snap.id, ...snap.data() };
}

export function publicAccount(account) {
    if (!account || account.status !== 'connected') {
        return { connected: false, automationEnabled: false };
    }
    return {
        connected: true,
        email: account.email || '',
        status: account.status,
        automationEnabled: account.automationEnabled !== false,
        lastSyncAt: account.lastSyncAt || null,
        lastError: account.lastError || null,
        incoming: account.incoming || 0,
        processed: account.processed || 0,
        replies: account.replies || 0,
        pending: account.pending || 0,
        failed: account.failed || 0,
    };
}

export async function saveTokens(restaurantId, { email, refreshToken, accessToken, expiresIn, historyId }) {
    const now = new Date().toISOString();
    const existing = await getAccount(restaurantId);
    await accounts().doc(String(restaurantId)).set({
        restaurantId: String(restaurantId),
        email,
        status: 'connected',
        automationEnabled: existing?.automationEnabled !== false,
        refreshTokenEnc: encryptSecret(refreshToken),
        accessTokenEnc: encryptSecret(accessToken),
        accessTokenExpiresAt: new Date(Date.now() + (Number(expiresIn) || 3600) * 1000).toISOString(),
        historyId: historyId || existing?.historyId || null,
        connectedAt: existing?.connectedAt || now,
        updatedAt: now,
        lastError: null,
        incoming: existing?.incoming || 0,
        processed: existing?.processed || 0,
        replies: existing?.replies || 0,
        pending: existing?.pending || 0,
        failed: existing?.failed || 0,
    }, { merge: true });
}

export function tokensOf(account) {
    return {
        refreshToken: decryptSecret(account.refreshTokenEnc),
        accessToken: decryptSecret(account.accessTokenEnc),
    };
}

export async function claimMessage(messageId) {
    const ref = db.collection(PROCESSED).doc(messageId);
    try {
        await ref.create({ messageId, at: new Date().toISOString() });
        return true;
    } catch (error) {
        const code = String(error.code || '');
        const message = String(error.message || '');
        if (code === '6' || code === 'already-exists' || message.includes('ALREADY_EXISTS') || message.includes('already exists')) return false;
        throw error;
    }
}
