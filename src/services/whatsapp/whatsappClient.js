// src/services/whatsapp/whatsappClient.js
// =============================================================================
// WHATSAPP CLOUD API CLIENT — outbound messages via Meta Graph API
// =============================================================================
// POST https://graph.facebook.com/{GRAPH_VERSION}/{WA_PHONE_ID}/messages
//
// Every send enforces Meta's interactive limits (3 buttons ≤ 20 chars,
// 10 list rows, titles ≤ 24, descriptions ≤ 72) and never throws: Graph API
// errors are logged and returned as { ok: false }.
// =============================================================================

import logger from '../../utils/logger.js';
import { getWhatsAppConfig, WA_LIMITS } from './whatsappConfig.js';

const REQUEST_TIMEOUT_MS = 10000;

export function clip(text, max) {
    const value = String(text ?? '').trim();
    if (value.length <= max) return value;
    return `${value.slice(0, max - 1).trimEnd()}…`;
}

/** At most 3 buttons, titles ≤ 20 chars. */
export function clampButtons(buttons) {
    return (buttons || []).slice(0, WA_LIMITS.MAX_BUTTONS).map((button) => ({
        type: 'reply',
        reply: {
            id: clip(button.id, WA_LIMITS.REPLY_ID),
            title: clip(button.title, WA_LIMITS.BUTTON_TITLE),
        },
    }));
}

/** At most 10 rows in total, titles ≤ 24, descriptions ≤ 72. */
export function clampListRows(rows) {
    return (rows || []).slice(0, WA_LIMITS.MAX_LIST_ROWS).map((row) => {
        const out = {
            id: clip(row.id, WA_LIMITS.REPLY_ID),
            title: clip(row.title, WA_LIMITS.LIST_ROW_TITLE),
        };
        if (row.description) out.description = clip(row.description, WA_LIMITS.LIST_ROW_DESCRIPTION);
        return out;
    });
}

/** Recipient as digits only (Cloud API accepts E.164 without "+"). */
function toRecipient(to) {
    return String(to || '').replace(/\D/g, '');
}

/**
 * @param {Object} [options]
 * @param {Function} [options.fetchImpl]  injectable for tests
 * @param {Function} [options.getConfig]  injectable for tests
 */
export function createWhatsAppClient({ fetchImpl = fetch, getConfig = getWhatsAppConfig } = {}) {
    async function post(payload, label) {
        const { token, phoneId, graphVersion } = getConfig();
        if (!token || !phoneId) {
            logger.error(`❌ [WhatsApp] ${label} not sent: WA_TOKEN or WA_PHONE_ID missing`);
            return { ok: false, error: 'WhatsApp is not configured' };
        }

        const url = `https://graph.facebook.com/${graphVersion}/${phoneId}/messages`;
        try {
            const response = await fetchImpl(url, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });

            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                const err = data?.error || {};
                logger.error(
                    `❌ [WhatsApp] Graph API ${label} failed (${response.status}) ` +
                    `code=${err.code ?? '-'} subcode=${err.error_subcode ?? '-'}: ${err.message || 'unknown error'}`
                );
                return { ok: false, status: response.status, error: err.message || `HTTP ${response.status}` };
            }

            return { ok: true, messageId: data?.messages?.[0]?.id || null };
        } catch (error) {
            logger.error(`❌ [WhatsApp] Graph API ${label} request failed: ${error.message}`);
            return { ok: false, error: error.message };
        }
    }

    return {
        sendText(to, body) {
            return post({
                recipient_type: 'individual',
                to: toRecipient(to),
                type: 'text',
                text: { preview_url: true, body: clip(body, WA_LIMITS.TEXT_BODY) },
            }, 'text');
        },

        /** @param {Array<{id: string, title: string}>} buttons */
        sendButtons(to, body, buttons) {
            return post({
                recipient_type: 'individual',
                to: toRecipient(to),
                type: 'interactive',
                interactive: {
                    type: 'button',
                    body: { text: clip(body, WA_LIMITS.INTERACTIVE_BODY) },
                    action: { buttons: clampButtons(buttons) },
                },
            }, 'buttons');
        },

        /**
         * Single-section list.
         * @param {Array<{id: string, title: string, description?: string}>} rows
         */
        sendList(to, body, buttonText, rows, sectionTitle = 'Options') {
            return post({
                recipient_type: 'individual',
                to: toRecipient(to),
                type: 'interactive',
                interactive: {
                    type: 'list',
                    body: { text: clip(body, WA_LIMITS.INTERACTIVE_BODY) },
                    action: {
                        button: clip(buttonText, WA_LIMITS.LIST_BUTTON_TEXT),
                        sections: [{
                            title: clip(sectionTitle, WA_LIMITS.LIST_SECTION_TITLE),
                            rows: clampListRows(rows),
                        }],
                    },
                },
            }, 'list');
        },

        /**
         * Approved template — the only way to message a customer outside the
         * 24-hour customer service window.
         * @param {string} to
         * @param {string} name               template name as approved in Meta
         * @param {Array<string|number>} [params] body variables {{1}}, {{2}}, …
         * @param {string} [languageCode]
         */
        sendTemplate(to, name, params = [], languageCode = 'en') {
            const template = { name, language: { code: languageCode } };
            if (params.length > 0) {
                template.components = [{
                    type: 'body',
                    parameters: params.map((value) => ({ type: 'text', text: String(value ?? '') })),
                }];
            }
            return post({ to: toRecipient(to), type: 'template', template }, `template "${name}"`);
        },

        /** Blue ticks; with { typing: true } also shows "typing…" until the reply (max ~25s). */
        async markRead(messageId, { typing = false } = {}) {
            if (typing) {
                const result = await post({
                    status: 'read',
                    message_id: messageId,
                    typing_indicator: { type: 'text' },
                }, 'mark-read+typing');
                if (result.ok) return result;
            }
            return post({ status: 'read', message_id: messageId }, 'mark-read');
        },
    };
}

export default createWhatsAppClient();
