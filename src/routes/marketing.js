import express from 'express';
import { getTenantById } from '../services/tenantService.js';
import whatsappClient from '../services/whatsapp/whatsappClient.js';
import logger from '../utils/logger.js';
import { MarketingError } from '../services/marketing/operations.js';
import * as marketing from '../services/marketing/operations.js';
import { getMarketingRuntime, getWorkerStats, wakeMarketingWorker } from '../services/marketing/runtime.js';

const router = express.Router();

function firestoreQuotaHit(error) {
    return error?.code === 8 || /RESOURCE_EXHAUSTED|Quota exceeded/i.test(`${error?.message || ''} ${error?.details || ''}`);
}

function fail(res, error) {
    if (error instanceof MarketingError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
    }
    if (firestoreQuotaHit(error)) {
        logger.error('❌ [Marketing] Firestore daily quota is used up.');
        return res.status(503).json({ error: 'Firestore daily quota is used up. Try again after it resets.', code: 'quota' });
    }
    logger.error(`❌ [Marketing] ${error.stack || error.message}`);
    return res.status(500).json({ error: 'Internal Server Error' });
}

async function scope(req, res) {
    const restaurantId = String(req.params.restaurantId || '').trim();
    if (!restaurantId) {
        res.status(400).json({ error: 'restaurantId is required' });
        return null;
    }
    const tenant = await getTenantById(restaurantId);
    if (!tenant || tenant.isActive === false) {
        res.status(404).json({ error: 'Restaurant not found' });
        return null;
    }
    return { restaurantId, tenant, store: getMarketingRuntime().store, meta: getMarketingRuntime().meta };
}

router.get('/worker-stats', (req, res) => {
    res.json(getWorkerStats());
});

router.get('/:restaurantId/overview', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        res.json(await marketing.getOverview(ctx.store, ctx.restaurantId));
    } catch (error) { fail(res, error); }
});

router.get('/:restaurantId/analytics', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        res.json(await marketing.getAnalytics(ctx.store, ctx.restaurantId));
    } catch (error) { fail(res, error); }
});

router.get('/:restaurantId/settings', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        res.json(await marketing.getSettings(ctx.store, ctx.restaurantId));
    } catch (error) { fail(res, error); }
});

router.put('/:restaurantId/settings', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        res.json(await marketing.saveSettings(ctx.store, ctx.restaurantId, req.body || {}));
    } catch (error) { fail(res, error); }
});

router.get('/:restaurantId/contacts', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        res.json(await marketing.listContacts(ctx.store, ctx.restaurantId, req.query));
    } catch (error) { fail(res, error); }
});

router.post('/:restaurantId/contacts', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        res.status(201).json(await marketing.saveContact(ctx.store, ctx.restaurantId, req.body || {}));
    } catch (error) { fail(res, error); }
});

router.patch('/:restaurantId/contacts/:contactId', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        res.json(await marketing.saveContact(ctx.store, ctx.restaurantId, req.body || {}, req.params.contactId));
    } catch (error) { fail(res, error); }
});

router.put('/:restaurantId/contacts/:contactId/tags', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        res.json(await marketing.setContactTags(ctx.store, ctx.restaurantId, req.params.contactId, req.body?.tags || []));
    } catch (error) { fail(res, error); }
});

router.post('/:restaurantId/contacts/group', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        res.json(await marketing.assignContactGroup(ctx.store, ctx.restaurantId, req.body || {}));
    } catch (error) { fail(res, error); }
});

router.post('/:restaurantId/contacts/import', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        res.json(await marketing.importContacts(ctx.store, ctx.restaurantId, req.body || {}));
    } catch (error) { fail(res, error); }
});

router.get('/:restaurantId/contacts/export', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        const csv = await marketing.exportContacts(ctx.store, ctx.restaurantId, { optedInOnly: req.query.optedInOnly !== 'false' });
        res.type('text/csv').send(csv);
    } catch (error) { fail(res, error); }
});

router.get('/:restaurantId/templates', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        res.json({ templates: await marketing.listTemplates(ctx.store, ctx.restaurantId) });
    } catch (error) { fail(res, error); }
});

router.post('/:restaurantId/templates', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        res.status(201).json(await marketing.saveTemplate(ctx.store, ctx.restaurantId, req.body || {}));
    } catch (error) { fail(res, error); }
});

router.patch('/:restaurantId/templates/:templateId', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        res.json(await marketing.saveTemplate(ctx.store, ctx.restaurantId, req.body || {}, req.params.templateId));
    } catch (error) { fail(res, error); }
});

router.post('/:restaurantId/templates/:templateId/submit', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        res.json(await marketing.submitTemplate(ctx.store, ctx.meta, ctx.restaurantId, req.params.templateId));
    } catch (error) { fail(res, error); }
});

router.post('/:restaurantId/templates/sync', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        res.json({ templates: await marketing.syncTemplates(ctx.store, ctx.meta, ctx.restaurantId) });
    } catch (error) { fail(res, error); }
});

router.delete('/:restaurantId/templates/:templateId', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        res.json(await marketing.deleteTemplate(ctx.store, ctx.meta, ctx.restaurantId, req.params.templateId));
    } catch (error) { fail(res, error); }
});

router.get('/:restaurantId/campaigns', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        res.json({ campaigns: await marketing.listCampaigns(ctx.store, ctx.restaurantId) });
    } catch (error) { fail(res, error); }
});

router.post('/:restaurantId/campaigns', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        res.status(201).json(await marketing.createCampaign(ctx.store, ctx.restaurantId, req.body || {}));
    } catch (error) { fail(res, error); }
});

router.post('/:restaurantId/campaigns/preview', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        const preview = await marketing.previewAudience(ctx.store, ctx.restaurantId, req.body?.audience || { type: 'all' });
        const price = Number(process.env.MARKETING_PRICE_PER_MESSAGE);
        res.json({
            ...preview,
            estimatedCost: Number.isFinite(price) && price > 0 ? preview.summary.eligible * price : null,
        });
    } catch (error) { fail(res, error); }
});

router.get('/:restaurantId/campaigns/:campaignId', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        res.json(await marketing.getCampaign(ctx.store, ctx.restaurantId, req.params.campaignId));
    } catch (error) { fail(res, error); }
});

router.patch('/:restaurantId/campaigns/:campaignId', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        res.json(await marketing.updateCampaign(ctx.store, ctx.restaurantId, req.params.campaignId, req.body || {}));
    } catch (error) { fail(res, error); }
});

router.post('/:restaurantId/campaigns/:campaignId/leads', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        const imported = await marketing.importCampaignLeads(ctx.store, ctx.restaurantId, req.params.campaignId, req.body || {});
        if (imported.queued) wakeMarketingWorker(0);
        res.json(imported);
    } catch (error) { fail(res, error); }
});

router.post('/:restaurantId/campaigns/:campaignId/launch', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        const result = await marketing.launchCampaign(ctx.store, ctx.restaurantId, req.params.campaignId, {
            confirm: req.body?.confirm === true,
            restaurantName: ctx.tenant.name,
        });
        const price = Number(process.env.MARKETING_PRICE_PER_MESSAGE);
        result.summary.estimatedCost = Number.isFinite(price) && price > 0 ? result.summary.eligible * price : null;
        const wait = result.campaign.status === 'scheduled' && result.campaign.sendAt
            ? Math.max(0, Date.parse(result.campaign.sendAt) - Date.now())
            : 0;
        wakeMarketingWorker(Number.isFinite(wait) ? wait : 0);
        res.json(result);
    } catch (error) { fail(res, error); }
});

router.post('/:restaurantId/campaigns/:campaignId/:action', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        const campaign = await marketing.setCampaignControl(ctx.store, ctx.restaurantId, req.params.campaignId, req.params.action);
        if (req.params.action === 'resume' || req.params.action === 'retry') wakeMarketingWorker(0);
        res.json(campaign);
    } catch (error) { fail(res, error); }
});

router.get('/:restaurantId/campaigns/:campaignId/recipients', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        res.json({ recipients: await marketing.listRecipients(ctx.store, ctx.restaurantId, req.params.campaignId, req.query) });
    } catch (error) { fail(res, error); }
});

router.get('/:restaurantId/conversations', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        res.json(await marketing.listConversations(ctx.store, ctx.restaurantId, req.query));
    } catch (error) { fail(res, error); }
});

router.get('/:restaurantId/conversations/:conversationId', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        res.json(await marketing.getConversation(ctx.store, ctx.restaurantId, req.params.conversationId, req.query));
    } catch (error) { fail(res, error); }
});

router.post('/:restaurantId/conversations/:conversationId/messages', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        res.status(201).json(await marketing.sendHumanMessage(
            ctx.store,
            whatsappClient,
            ctx.restaurantId,
            req.params.conversationId,
            { text: req.body?.text, actor: req.body?.actor },
        ));
    } catch (error) { fail(res, error); }
});

router.post('/:restaurantId/conversations/:conversationId/mode', async (req, res) => {
    try {
        const ctx = await scope(req, res);
        if (!ctx) return;
        res.json(await marketing.setConversationMode(
            ctx.store,
            ctx.restaurantId,
            req.params.conversationId,
            req.body?.mode,
            req.body?.actor,
        ));
    } catch (error) { fail(res, error); }
});

export default router;
