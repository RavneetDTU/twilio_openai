// src/services/whatsapp/whatsappSessionStore.js
// =============================================================================
// WHATSAPP SESSION + DEDUPE STORE — Firestore
// =============================================================================
// whatsappSessions/{waId}               conversation step + collected answers
// whatsappProcessedMessages/{messageId} one doc per Meta message id; create()
//                                       fails if it exists, so retries are ignored
//
// Both carry `expiresAt` so a Firestore TTL policy can clean them up.
// =============================================================================

export const SESSIONS_COLLECTION = 'whatsappSessions';
export const PROCESSED_COLLECTION = 'whatsappProcessedMessages';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PROCESSED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ALREADY_EXISTS = 6;

function isAlreadyExists(error) {
    return error?.code === ALREADY_EXISTS || /ALREADY_EXISTS/i.test(error?.message || '');
}

/** Firestore Timestamp | Date | string | number → epoch ms (or null). */
export function toMillis(value) {
    if (!value) return null;
    if (typeof value.toMillis === 'function') return value.toMillis();
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? null : ms;
}

export function createFirestoreSessionStore(db) {
    const sessions = () => db.collection(SESSIONS_COLLECTION);
    const processed = () => db.collection(PROCESSED_COLLECTION);

    return {
        async get(waId) {
            const doc = await sessions().doc(waId).get();
            return doc.exists ? doc.data() : null;
        },

        async save(waId, session) {
            const now = Date.now();
            await sessions().doc(waId).set({
                ...session,
                waId,
                updatedAt: new Date(now),
                expiresAt: new Date(now + SESSION_TTL_MS),
            });
        },

        async clear(waId) {
            await sessions().doc(waId).delete();
        },

        /** @returns {Promise<boolean>} true the first time a message id is seen */
        async markMessageProcessed(messageId, meta = {}) {
            const now = Date.now();
            try {
                await processed().doc(messageId).create({
                    ...meta,
                    messageId,
                    receivedAt: new Date(now),
                    expiresAt: new Date(now + PROCESSED_TTL_MS),
                });
                return true;
            } catch (error) {
                if (isAlreadyExists(error)) return false;
                throw error;
            }
        },
    };
}

/** Same interface, in memory — for tests. */
export function createMemorySessionStore() {
    const sessions = new Map();
    const processed = new Set();
    return {
        sessions,
        async get(waId) {
            return sessions.has(waId) ? structuredClone(sessions.get(waId)) : null;
        },
        async save(waId, session) {
            sessions.set(waId, structuredClone({ ...session, waId, updatedAt: new Date() }));
        },
        async clear(waId) {
            sessions.delete(waId);
        },
        async markMessageProcessed(messageId) {
            if (processed.has(messageId)) return false;
            processed.add(messageId);
            return true;
        },
    };
}
