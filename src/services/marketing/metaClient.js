import { getWhatsAppConfig } from '../whatsapp/whatsappConfig.js';

async function graph(fetchImpl, path, { method = 'GET', body } = {}) {
    const { token, graphVersion, wabaId } = getWhatsAppConfig();
    if (!token || !wabaId) {
        return { ok: false, status: 503, code: 'NOT_CONFIGURED', error: 'Set WA_TOKEN and WA_WABA_ID on the server before using Meta templates.' };
    }
    const url = path.startsWith('http') ? path : `https://graph.facebook.com/${graphVersion}/${path}`;
    try {
        const response = await fetchImpl(url, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(15000),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const err = data?.error || {};
            return {
                ok: false,
                status: response.status,
                code: err.code || 'meta_error',
                error: err.error_user_msg || err.message || `Meta request failed (${response.status})`,
            };
        }
        return { ok: true, data };
    } catch (error) {
        return { ok: false, status: 502, code: 'network', error: error.message };
    }
}

function readBody(components = []) {
    const body = components.find((item) => String(item.type).toUpperCase() === 'BODY');
    return body?.text || '';
}

export function createMetaTemplateClient({ fetchImpl = fetch, getConfig = getWhatsAppConfig } = {}) {
    return {
        async list() {
            const { wabaId } = getConfig();
            const templates = [];
            let path = `${wabaId}/message_templates?limit=100`;
            for (let page = 0; page < 10 && path; page += 1) {
                const result = await graph(fetchImpl, path);
                if (!result.ok) return result;
                for (const item of result.data?.data || []) {
                    templates.push({
                        id: item.id,
                        name: item.name,
                        status: item.status,
                        category: item.category,
                        language: item.language,
                        rejected_reason: item.rejected_reason || null,
                        body: readBody(item.components),
                    });
                }
                path = result.data?.paging?.next || '';
            }
            return { ok: true, templates };
        },

        async create(payload) {
            const { wabaId } = getConfig();
            const result = await graph(fetchImpl, `${wabaId}/message_templates`, { method: 'POST', body: payload });
            if (!result.ok) return result;
            return {
                ok: true,
                id: result.data?.id || null,
                status: result.data?.status || null,
                rejectionReason: result.data?.rejected_reason || null,
            };
        },

        async remove(name) {
            const { wabaId } = getConfig();
            return graph(fetchImpl, `${wabaId}/message_templates?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
        },
    };
}
