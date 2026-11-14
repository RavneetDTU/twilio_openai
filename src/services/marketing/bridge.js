import { getTenantById } from '../tenantService.js';
import { getWhatsAppConfig } from '../whatsapp/whatsappConfig.js';
import { applyStatuses, applyTemplateUpdate, routeInbound } from './inbound.js';
import { createFirestoreMarketingStore } from './store.js';

export function createMarketingBridge({ db, getBookingDeps }) {
    const store = createFirestoreMarketingStore(db);
    return {
        routeInbound(payload) {
            const deps = getBookingDeps();
            return routeInbound({
                store,
                ...payload,
                deps,
                openai: deps.ai || null,
                model: process.env.MARKETING_AI_MODEL || process.env.WA_AI_MODEL || '',
                loadTenant: getTenantById,
                getConfig: getWhatsAppConfig,
            });
        },
        applyStatuses(statuses) {
            return applyStatuses(store, statuses || []);
        },
        applyTemplateStatus(value) {
            return applyTemplateUpdate(store, value || {});
        },
    };
}
