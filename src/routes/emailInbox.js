import express from 'express';
import { getTenantById } from '../services/tenantService.js';
import { emailSecretsReady, readState, signState } from '../services/emailBooking/crypto.js';
import { authorizationUrl, exchangeCode, gmailGet } from '../services/emailBooking/gmail.js';
import { accounts, getAccount, publicAccount, saveTokens } from '../services/emailBooking/accounts.js';
import { getThread, listThreads, replyOnThread, setThreadAutoReply, syncAccount } from '../services/emailBooking/processor.js';
import admin from '../config/firebase.js';
import logger from '../utils/logger.js';

const router = express.Router();

function redirectUri() {
    return process.env.GOOGLE_OAUTH_REDIRECT_URI || '';
}

function dashboardUrl(query) {
    const base = process.env.EMAIL_DASHBOARD_URL || 'http://localhost:5173/email';
    const url = new URL(base);
    Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
    return url.toString();
}

router.get('/:restaurantId/status', async (req, res) => {
    try {
        const account = await getAccount(req.params.restaurantId);
        res.json({ ...publicAccount(account), configured: emailSecretsReady() && Boolean(redirectUri()) });
    } catch (error) {
        res.status(500).json({ error: 'Could not read the email connection.' });
    }
});

router.get('/:restaurantId/connect', async (req, res) => {
    try {
        if (!emailSecretsReady() || !redirectUri()) {
            return res.status(503).json({ error: 'Gmail is not configured on the server yet.' });
        }
        const tenant = await getTenantById(req.params.restaurantId);
        if (!tenant || tenant.isActive === false) return res.status(404).json({ error: 'Restaurant not found' });
        const url = authorizationUrl({
            clientId: process.env.GOOGLE_CLIENT_ID,
            redirectUri: redirectUri(),
            state: signState(tenant.restaurantId),
        });
        res.json({ url });
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message || 'Could not start Gmail connection.' });
    }
});

router.get('/google/callback', async (req, res) => {
    const state = readState(req.query.state);
    if (!state || !req.query.code) return res.redirect(dashboardUrl({ error: 'gmail_denied' }));
    try {
        const tokens = await exchangeCode({
            code: req.query.code,
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            redirectUri: redirectUri(),
        });
        if (!tokens.refresh_token) return res.redirect(dashboardUrl({ error: 'gmail_no_refresh' }));
        const profile = await gmailGet('/profile', tokens.access_token);
        await saveTokens(state.restaurantId, {
            email: profile.emailAddress,
            refreshToken: tokens.refresh_token,
            accessToken: tokens.access_token,
            expiresIn: tokens.expires_in,
            historyId: profile.historyId,
        });
        res.redirect(dashboardUrl({ connected: '1' }));
    } catch (error) {
        logger.error(`Gmail callback failed: ${error.message}`);
        res.redirect(dashboardUrl({ error: 'gmail_failed' }));
    }
});

router.post('/:restaurantId/disconnect', async (req, res) => {
    const account = await getAccount(req.params.restaurantId);
    if (!account) return res.json({ connected: false });
    await accounts().doc(String(req.params.restaurantId)).set({
        status: 'disconnected',
        refreshTokenEnc: admin.firestore.FieldValue.delete(),
        accessTokenEnc: admin.firestore.FieldValue.delete(),
        accessTokenExpiresAt: admin.firestore.FieldValue.delete(),
        historyId: admin.firestore.FieldValue.delete(),
        disconnectedAt: new Date().toISOString(),
    }, { merge: true });
    res.json({ connected: false });
});

router.patch('/:restaurantId/automation', async (req, res) => {
    const account = await getAccount(req.params.restaurantId);
    if (!account || account.status !== 'connected') return res.status(404).json({ error: 'Gmail is not connected.' });
    await accounts().doc(account.restaurantId).set({ automationEnabled: req.body?.enabled === true }, { merge: true });
    res.json(publicAccount(await getAccount(req.params.restaurantId)));
});

router.get('/:restaurantId/threads', async (req, res) => {
    try {
        const items = await listThreads(req.params.restaurantId);
        res.json({ threads: items });
    } catch (error) {
        res.status(500).json({ error: 'Could not load email conversations.' });
    }
});

router.patch('/:restaurantId/threads/:threadId/auto-reply', async (req, res) => {
    try {
        const thread = await setThreadAutoReply(req.params.restaurantId, req.params.threadId, req.body?.enabled === true);
        res.json({ threadId: req.params.threadId, autoReply: thread.autoReply !== false });
    } catch (error) {
        res.status(error.status || 500).json({ error: error.status === 404 ? 'Conversation not found' : 'Could not update auto reply.' });
    }
});

router.get('/:restaurantId/threads/:threadId', async (req, res) => {
    const thread = await getThread(req.params.restaurantId, req.params.threadId);
    if (!thread) return res.status(404).json({ error: 'Conversation not found' });
    res.json(thread);
});

router.post('/:restaurantId/threads/:threadId/reply', async (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Write a reply first.' });
    try {
        const thread = await replyOnThread(req.params.restaurantId, req.params.threadId, text);
        res.json(thread);
    } catch (error) {
        logger.error(`Email reply failed: ${error.message}`);
        res.status(error.status || 502).json({ error: 'The reply was not sent.' });
    }
});

router.post('/:restaurantId/sync', async (req, res) => {
    try {
        const status = await syncAccount(req.params.restaurantId);
        res.json(status);
    } catch (error) {
        logger.error(`Email sync failed: ${error.message}`);
        await accounts().doc(String(req.params.restaurantId)).set({ lastError: 'The last Gmail sync failed.', failed: (await getAccount(req.params.restaurantId))?.failed + 1 || 1 }, { merge: true }).catch(() => {});
        res.status(502).json({ error: 'Gmail sync failed.' });
    }
});

export default router;
