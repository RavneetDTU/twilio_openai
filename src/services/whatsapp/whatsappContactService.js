// src/services/whatsapp/whatsappContactService.js
// =============================================================================
// WHATSAPP CONTACTS (leads) — Firestore whatsappContacts/{waId}
// =============================================================================
// Guests themselves live in the Mybooki API (matched by phone). This keeps the
// WhatsApp-side record: number, name, restaurants, last booking. On first
// contact it links an earlier voice call from the same number (callLogs
// .customerPhone) so the guest's name can be reused.
// =============================================================================

export const CONTACTS_COLLECTION = 'whatsappContacts';

/**
 * @param {Object} deps
 * @param {FirebaseFirestore.Firestore} deps.db
 * @param {Object} deps.FieldValue  admin.firestore.FieldValue
 */
export function createContactService({ db, FieldValue }) {
    const contacts = () => db.collection(CONTACTS_COLLECTION);

    async function findVoiceCall(waId) {
        const snapshot = await db.collection('callLogs')
            .where('customerPhone', '==', `+${waId}`)
            .limit(1)
            .get();
        if (snapshot.empty) return null;
        const doc = snapshot.docs[0];
        return { callSid: doc.id, name: doc.data()?.booking?.name || null };
    }

    return {
        /** Name from an earlier WhatsApp booking, else from a voice call. */
        async getKnownName(waId) {
            const doc = await contacts().doc(waId).get();
            if (doc.exists && doc.data()?.name) return doc.data().name;
            const voice = await findVoiceCall(waId);
            return voice?.name || null;
        },

        async saveBooking({ waId, profileName, restaurantId, data, paymentId }) {
            const ref = contacts().doc(waId);
            const existing = await ref.get();
            const now = new Date();

            const update = {
                waId,
                whatsappNumber: `+${waId}`,
                channel: 'whatsapp',
                name: data.name,
                phone: data.phone,
                profileName: profileName || null,
                restaurantIds: FieldValue.arrayUnion(String(restaurantId)),
                lastRestaurantId: String(restaurantId),
                lastBooking: {
                    paymentId,
                    restaurantId: String(restaurantId),
                    date: data.date,
                    time: data.time,
                    guests: Number(data.guests),
                    createdAt: now,
                },
                bookingCount: FieldValue.increment(1),
                updatedAt: now,
            };

            if (!existing.exists) {
                const voice = await findVoiceCall(waId).catch(() => null);
                update.createdAt = now;
                update.firstChannel = voice ? 'voice' : 'whatsapp';
                update.linkedVoiceCallSid = voice?.callSid || null;
            }

            await ref.set(update, { merge: true });
        },
    };
}
