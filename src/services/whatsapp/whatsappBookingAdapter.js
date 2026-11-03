// src/services/whatsapp/whatsappBookingAdapter.js
// =============================================================================
// WHATSAPP → EXISTING BOOKING PIPELINE
// =============================================================================
// checkSlot: capacityService.getAvailableCapacityForDate (the same
//            check-availability call the voice agent uses). Fails open when
//            the API is unreachable, exactly like the voice tool.
// book:      re-checks the slot, then calls the existing
//            manualBookingService.createManualBooking with
//            source 'whatsapp', the sitting id, and channel fields.
//
// The check and the insert are separate API calls, so the reservation API is
// the only place that can fully prevent two channels taking the last seats.
// =============================================================================

import logger from '../../utils/logger.js';
import { chooseSitting } from '../capacityService.js';
import { hmToMinutes } from './whatsappDateTime.js';

const MAX_ALTERNATIVES = 3;
const MAX_ALTERNATIVE_CHECKS = 6;

/**
 * @returns {{ok: true, sittingId: any, failOpen?: boolean}
 *         | {ok: false, reason: 'closed'|'full', message?: string, seatsLeft?: number|null}}
 */
export function evaluateCapacity(capacity, guests) {
    if (!capacity || capacity.checkFailed || capacity.needsTime) {
        return { ok: true, sittingId: null, failOpen: true };
    }
    if (!capacity.isOpen) {
        return { ok: false, reason: 'closed', message: capacity.closedReason || null };
    }
    const sitting = chooseSitting(capacity.matches || [], Number(guests), capacity.sittingId);
    if (!sitting) {
        return { ok: false, reason: 'full', seatsLeft: capacity.available ?? null };
    }
    return { ok: true, sittingId: sitting.sittingId ?? null };
}

export function depositFor(restaurant, guests) {
    const deposit = Number(restaurant?.depositAmount) || 0;
    return Number(guests) * deposit;
}

/**
 * @param {Object} deps
 * @param {Function} deps.getAvailableCapacityForDate  capacityService export
 * @param {Function} deps.createManualBooking          manualBookingService.createManualBooking
 * @param {string}   deps.paymentBaseUrl               smsService.paymentBaseUrl
 * @param {Function} [deps.getConfig]                  () => ({ alsoSendSms })
 */
export function createBookingAdapter({
    getAvailableCapacityForDate,
    createManualBooking,
    paymentBaseUrl,
    getConfig = () => ({ alsoSendSms: false }),
}) {
    async function checkSlot(restaurantId, date, time, guests) {
        const capacity = await getAvailableCapacityForDate(null, restaurantId, date, time);
        const result = evaluateCapacity(capacity, guests);
        if (result.failOpen) {
            logger.warn(`⚠️ [WhatsApp] Capacity check unavailable for ${restaurantId} ${date} ${time} — not blocking`);
        }
        return result;
    }

    /** Nearest other times (from `candidates`) that can seat the party. */
    async function findAlternatives(restaurantId, date, time, guests, candidates = []) {
        const target = hmToMinutes(time);
        const nearest = [...new Set(candidates)]
            .filter((hm) => hm !== time)
            .sort((a, b) => Math.abs(hmToMinutes(a) - target) - Math.abs(hmToMinutes(b) - target))
            .slice(0, MAX_ALTERNATIVE_CHECKS);

        const checks = await Promise.all(nearest.map(async (hm) => {
            try {
                const capacity = await getAvailableCapacityForDate(null, restaurantId, date, hm);
                if (capacity.checkFailed) return null;
                return evaluateCapacity(capacity, guests).ok ? hm : null;
            } catch (error) {
                logger.warn(`⚠️ [WhatsApp] Alternative check failed for ${date} ${hm}: ${error.message}`);
                return null;
            }
        }));

        return checks.filter(Boolean).slice(0, MAX_ALTERNATIVES).sort();
    }

    /**
     * @returns {Promise<{status: 'booked', paymentId, bookingAmount, paymentLink}
     *          | {status: 'unavailable', check}
     *          | {status: 'error', error}>}
     */
    async function book({ restaurant, waId, data }) {
        const check = await checkSlot(restaurant.id, data.date, data.time, data.guests);
        if (!check.ok) return { status: 'unavailable', check };

        try {
            const result = await createManualBooking(
                restaurant.id,
                {
                    name: data.name,
                    phoneNo: data.phone,
                    guests: Number(data.guests),
                    date: data.date,
                    time: data.time,
                    notes: data.requests || undefined,
                },
                {
                    source: 'whatsapp',
                    sittingId: check.sittingId ?? data.sittingId ?? null,
                    skipSms: !getConfig().alsoSendSms,
                    extraFields: {
                        channel: 'whatsapp',
                        whatsappNumber: `+${waId}`,
                    },
                }
            );

            const bookingAmount = depositFor(restaurant, data.guests);
            const paymentLink = bookingAmount > 0 ? `${paymentBaseUrl}/payment/${result.paymentId}` : null;
            logger.info(`✅ [WhatsApp] Booking ${result.paymentId} created for +${waId} at ${restaurant.id}`);
            return { status: 'booked', paymentId: result.paymentId, bookingAmount, paymentLink };
        } catch (error) {
            logger.error(`❌ [WhatsApp] Booking failed for +${waId} at ${restaurant.id}: ${error.message}`);
            return { status: 'error', error: error.message };
        }
    }

    return { checkSlot, findAlternatives, book };
}
