// Background sender. Campaign state lives in Firestore, so a restart continues
// a running campaign instead of sending it again from the beginning.
// The worker stays asleep until a launch, resume, retry, scheduled time, or
// the slow recovery check. It does not scan idle campaigns on a timer.

import logger from '../../utils/logger.js';
import { db } from '../../config/firebase.js';
import { getTenantById } from '../tenantService.js';
import whatsappClient from '../whatsapp/whatsappClient.js';
import { progressCampaign, recoverStuckRecipients } from './engine.js';
import { createMetaTemplateClient } from './metaClient.js';
import { createFirestoreMarketingStore } from './store.js';

const ACTIVE = ['queued', 'running', 'scheduled'];
const workerStats = {
    ticks: 0,
    idleSweeps: 0,
    batches: 0,
    wakes: 0,
    stuckChecks: 0,
    recovered: 0,
    lastTickAt: null,
    idleSince: null,
    quotaPauses: 0,
};

let runtime = null;
let wakeTimer = null;
let quotaPausedUntil = 0;

export function getWorkerStats() {
    return {
        ...workerStats,
        idleForMs: workerStats.idleSince ? Date.now() - workerStats.idleSince : 0,
        quotaPaused: Date.now() < quotaPausedUntil,
    };
}

export function getMarketingRuntime() {
    if (!runtime) {
        const intervalMs = Number(process.env.MARKETING_SEND_INTERVAL_MS) || 250;
        const pace = {
            nextSlot: 0,
            intervalMs,
            batchSize: Number(process.env.MARKETING_BATCH_SIZE) || 20,
            maxAttempts: Number(process.env.MARKETING_MAX_ATTEMPTS) || 4,
        };
        pace.noteSend = (at) => {
            pace.nextSlot = at + pace.intervalMs;
        };
        runtime = {
            store: createFirestoreMarketingStore(db),
            meta: createMetaTemplateClient(),
            pace,
            timer: null,
            ticking: false,
        };
    }
    return runtime;
}

function firestoreQuotaHit(error) {
    return error?.code === 8 || /RESOURCE_EXHAUSTED|Quota exceeded/i.test(`${error?.message || ''} ${error?.details || ''}`);
}

function onTickError(error) {
    if (error?.code === 9 || /requires an index/i.test(error?.message || '')) {
        logger.error('❌ [Marketing] A Firestore index is missing. Create the indexes in firestore.indexes.json before sending a campaign.');
        return;
    }
    if (firestoreQuotaHit(error)) {
        quotaPausedUntil = Date.now() + 15 * 60 * 1000;
        workerStats.quotaPauses += 1;
        logger.error('❌ [Marketing] Firestore daily quota is used up. Campaign checks are paused for 15 minutes.');
        return;
    }
    logger.error(`❌ [Marketing] Worker tick failed: ${error.message}`);
}

function sweepMs() {
    return Number(process.env.MARKETING_SWEEP_MS) || 3600000;
}

function maxConcurrent() {
    return Math.max(1, Number(process.env.MARKETING_MAX_CONCURRENT) || 3);
}

export function wakeMarketingWorker(delayMs = 0, runtimeArg = null) {
    const active = runtimeArg || getMarketingRuntime();
    workerStats.wakes += 1;
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => {
        wakeTimer = null;
        marketingTick(active).catch(onTickError);
    }, Math.max(0, delayMs));
    if (typeof wakeTimer.unref === 'function') wakeTimer.unref();
}

export async function marketingTick(runtimeArg = getMarketingRuntime(), now = new Date()) {
    const active = runtimeArg;
    if (active.ticking) return;
    if (Date.now() < quotaPausedUntil) return;
    active.ticking = true;
    workerStats.ticks += 1;
    workerStats.lastTickAt = now.toISOString();
    try {
        const campaigns = await active.store.query('campaigns', {
            filters: [{ field: 'status', op: 'in', value: ACTIVE }],
            limit: 50,
        });
        const due = [];
        let scheduledWait = null;
        for (const campaign of campaigns) {
            if (campaign.status === 'scheduled' && campaign.sendAt && Date.parse(campaign.sendAt) > now.getTime()) {
                const wait = Date.parse(campaign.sendAt) - now.getTime();
                if (scheduledWait == null || wait < scheduledWait) scheduledWait = wait;
                continue;
            }
            due.push(campaign);
        }
        if (!due.length) {
            workerStats.idleSweeps += 1;
            if (!workerStats.idleSince) workerStats.idleSince = Date.now();
            if (scheduledWait != null && active.autoWake !== false) wakeMarketingWorker(Math.min(scheduledWait, sweepMs()), active);
            return;
        }
        workerStats.idleSince = null;
        const slice = due.slice(0, maxConcurrent());
        let followUp = null;
        for (const campaign of slice) {
            const loadTenant = active.loadTenant || getTenantById;
            const tenant = await loadTenant(campaign.restaurantId).catch(() => null);
            const result = await progressCampaign({
                store: active.store,
                sender: (payload) => whatsappClient.sendTemplateMessage(payload.to, payload),
                now,
                campaign,
                limits: active.pace,
                restaurantName: tenant?.name || campaign.restaurantName || '',
            });
            workerStats.batches += 1;
            if (result?.nextDelayMs != null) {
                followUp = followUp == null ? result.nextDelayMs : Math.min(followUp, result.nextDelayMs);
            } else if (result && ['queued', 'running', 'scheduled'].includes(result.status)) {
                followUp = followUp == null ? Math.max(active.pace.intervalMs || 0, 250) : Math.min(followUp, Math.max(active.pace.intervalMs || 0, 250));
            }
        }
        if (due.length > slice.length) followUp = followUp == null ? 250 : Math.min(followUp, 250);
        if (followUp != null && active.autoWake !== false) wakeMarketingWorker(followUp, active);
    } finally {
        active.ticking = false;
    }
}

export async function recoverStuckSends(runtimeArg = getMarketingRuntime(), now = new Date()) {
    if (Date.now() < quotaPausedUntil) return 0;
    workerStats.stuckChecks += 1;
    const recovered = await recoverStuckRecipients(runtimeArg.store, now);
    workerStats.recovered += recovered;
    if (recovered > 0 && runtimeArg.autoWake !== false) wakeMarketingWorker(0, runtimeArg);
    return recovered;
}

export function startMarketingWorker() {
    const active = getMarketingRuntime();
    if (active.timer) return;
    const sweep = sweepMs();
    const stuckEvery = Number(process.env.MARKETING_STUCK_MS) || 60000;
    marketingTick(active).catch(onTickError);
    active.timer = setInterval(() => marketingTick(active).catch(onTickError), sweep);
    active.stuckTimer = setInterval(() => {
        recoverStuckSends(active).catch((error) => logger.error(`❌ [Marketing] Stuck-send check failed: ${error.message}`));
    }, stuckEvery);
    if (typeof active.timer.unref === 'function') active.timer.unref();
    if (typeof active.stuckTimer.unref === 'function') active.stuckTimer.unref();
    logger.info(`📣 [Marketing] Campaign worker is idle until a campaign is launched. Recovery check every ${Math.round(sweep / 1000)}s.`);
}
