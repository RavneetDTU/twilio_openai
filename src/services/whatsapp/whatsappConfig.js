// src/services/whatsapp/whatsappConfig.js
// =============================================================================
// WHATSAPP BOOKING CHANNEL — configuration
// =============================================================================
// Feature flag: WHATSAPP_ENABLED=true (default off). With the flag off the
// webhook route is never mounted and nothing in this folder runs.
//
// Everything is read at call time — ESM imports run before dotenv.config()
// in server.js, so module-level reads of process.env would be empty.
// =============================================================================

/** Meta Cloud API limits for interactive messages. */
export const WA_LIMITS = {
    MAX_BUTTONS: 3,
    BUTTON_TITLE: 20,
    MAX_LIST_ROWS: 10,
    LIST_ROW_TITLE: 24,
    LIST_ROW_DESCRIPTION: 72,
    LIST_BUTTON_TEXT: 20,
    LIST_SECTION_TITLE: 24,
    INTERACTIVE_BODY: 1024,
    TEXT_BODY: 4096,
    REPLY_ID: 256,
};

export const DEFAULT_GRAPH_VERSION = 'v21.0';
export const DEFAULT_TIMEZONE = 'Africa/Johannesburg';

export function isWhatsAppEnabled() {
    return process.env.WHATSAPP_ENABLED === 'true';
}

export function getWhatsAppConfig() {
    return {
        token: process.env.WA_TOKEN || '',
        phoneId: process.env.WA_PHONE_ID || '',
        graphVersion: process.env.GRAPH_VERSION || DEFAULT_GRAPH_VERSION,
        verifyToken: process.env.VERIFY_TOKEN || '',
        appSecret: process.env.APP_SECRET || '',
        menuUrl: process.env.MENU_URL || '',
        contactInfo: process.env.CONTACT_INFO || '',
        timezone: process.env.WA_TIMEZONE || '',
        restaurantId: process.env.WA_RESTAURANT_ID || '',
        alsoSendSms: process.env.WA_ALSO_SEND_SMS === 'true',
    };
}
