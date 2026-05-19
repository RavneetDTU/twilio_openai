import logger from '../utils/logger.js';

const RESERVATION_API_BASE = 'https://mybookiapis.booki.co.za/restaurants';

/**
 * Fetches the total booked guest count for a SPECIFIC date from the
 * external Reservation API (mybookiapis.booki.co.za).
 *
 * @param {string} restaurantId  - Restaurant ID (e.g. "1")
 * @param {string} dateStr       - Date string in YYYY-MM-DD format
 * @returns {Promise<number>}    - Total guests already booked on that date (AI + manual)
 */
export async function getBookedGuestsForDate(restaurantId, dateStr) {
    const url = `${RESERVATION_API_BASE}/${restaurantId}/reservations`;

    try {
        logger.info(`📡 [Capacity] Fetching bookings for ${dateStr} from API: ${url}?date=${dateStr}`);

        const response = await fetch(`${url}?date=${dateStr}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            const errText = await response.text();
            logger.error(`❌ [Capacity] Reservation API error (${response.status}): ${errText}`);
            return 0; // Safe fallback — don't block the call
        }

        const data = await response.json();
        const totalGuests = Number(data.total_guests) || 0;
        logger.info(`✅ [Capacity] Booked guests on ${dateStr} for restaurant ${restaurantId}: ${totalGuests}`);
        return totalGuests;

    } catch (err) {
        logger.error(`❌ [Capacity] Failed to fetch bookings for ${dateStr}: ${err.message}`);
        return 0; // Safe fallback
    }
}

/**
 * Computes available seating for a SPECIFIC booking date.
 *
 * Formula:
 *   available = totalCapacity - bookedByAI(date) - otherSourceBookings(date)
 *
 * `otherBookingsByDate` is a map stored in settings:
 *   { "2026-05-22": 4, "2026-05-23": 2 }
 *
 * @param {Object} settings       - Restaurant settings from prompts.json
 * @param {string} restaurantId   - Restaurant ID
 * @param {string} dateStr        - Date in YYYY-MM-DD format
 * @returns {Promise<{totalCapacity, aiBooked, otherBookings, available, dateStr}>}
 */
export async function getAvailableCapacityForDate(settings, restaurantId, dateStr) {
    const totalCapacity = Number(settings?.totalCapacity) || 0;

    // Per-date other-source bookings map (e.g. { "2026-05-22": 4 })
    const otherBookingsByDate = settings?.otherBookingsByDate || {};
    const otherBookings = Number(otherBookingsByDate[dateStr]) || 0;

    const aiBooked = await getBookedGuestsForDate(restaurantId, dateStr);

    const available = Math.max(0, totalCapacity - aiBooked - otherBookings);

    logger.info(
        `📊 [Capacity] Restaurant ${restaurantId} on ${dateStr} | ` +
        `Total: ${totalCapacity} | AI Booked: ${aiBooked} | Other: ${otherBookings} | Available: ${available}`
    );

    return { totalCapacity, aiBooked, otherBookings, available, dateStr };
}
