const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
];

export function gmailScopes() {
    return SCOPES.join(' ');
}

export function authorizationUrl({ clientId, redirectUri, state }) {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', gmailScopes());
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('state', state);
    return url.toString();
}

export async function exchangeCode({ code, clientId, clientSecret, redirectUri }) {
    return tokenRequest({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
    });
}

export async function refreshAccessToken({ refreshToken, clientId, clientSecret }) {
    return tokenRequest({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
    });
}

async function tokenRequest(body) {
    const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data.error_description || data.error || 'Google token request failed');
        error.status = response.status;
        throw error;
    }
    return data;
}

export async function gmailGet(path, accessToken) {
    const response = await fetch(`${GMAIL}${path}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data.error?.message || 'Gmail request failed');
        error.status = response.status;
        throw error;
    }
    return data;
}

export async function gmailSend({ accessToken, raw, threadId }) {
    const response = await fetch(`${GMAIL}/messages/send`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw, threadId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data.error?.message || 'Gmail send failed');
        error.status = response.status;
        throw error;
    }
    return data;
}

export function encodeRawMessage({ from, to, subject, body, inReplyTo, references }) {
    const lines = [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
    ];
    if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
    if (references) lines.push(`References: ${references}`);
    lines.push('', body);
    return Buffer.from(lines.join('\r\n')).toString('base64url');
}

export function decodeBody(message) {
    const parts = [];
    const walk = (node) => {
        if (!node) return;
        if (node.mimeType === 'text/plain' && node.body?.data) parts.push(Buffer.from(node.body.data, 'base64url').toString('utf8'));
        (node.parts || []).forEach(walk);
    };
    walk(message.payload);
    if (!parts.length && message.payload?.body?.data) {
        parts.push(Buffer.from(message.payload.body.data, 'base64url').toString('utf8'));
    }
    return parts.join('\n').slice(0, 8000);
}

export function header(message, name) {
    const headers = message.payload?.headers || [];
    return headers.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value || '';
}
