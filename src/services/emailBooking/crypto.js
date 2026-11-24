import crypto from 'crypto';

function key() {
    const raw = process.env.EMAIL_TOKEN_KEY || '';
    if (!raw) return null;
    return crypto.createHash('sha256').update(raw).digest();
}

export function emailSecretsReady() {
    return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.EMAIL_TOKEN_KEY);
}

export function encryptSecret(plain) {
    const secretKey = key();
    if (!secretKey) {
        const error = new Error('EMAIL_TOKEN_KEY is not set');
        error.status = 503;
        throw error;
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', secretKey, iv);
    const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, body]).toString('base64');
}

export function decryptSecret(packed) {
    const secretKey = key();
    if (!secretKey || !packed) return '';
    const buf = Buffer.from(packed, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const body = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

export function signState(restaurantId) {
    const secret = process.env.EMAIL_OAUTH_STATE_SECRET || process.env.EMAIL_TOKEN_KEY || '';
    if (!secret) {
        const error = new Error('EMAIL_TOKEN_KEY is not set');
        error.status = 503;
        throw error;
    }
    const payload = Buffer.from(JSON.stringify({
        restaurantId: String(restaurantId),
        exp: Date.now() + 10 * 60 * 1000,
        n: crypto.randomBytes(8).toString('hex'),
    })).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${sig}`;
}

export function readState(state) {
    const secret = process.env.EMAIL_OAUTH_STATE_SECRET || process.env.EMAIL_TOKEN_KEY || '';
    const [payload, sig] = String(state || '').split('.');
    if (!payload || !sig || !secret) return null;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!data.restaurantId || Number(data.exp) < Date.now()) return null;
        return data;
    } catch {
        return null;
    }
}
