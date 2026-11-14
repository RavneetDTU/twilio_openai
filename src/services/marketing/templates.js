// Meta WhatsApp template rules used before anything is sent to Graph API.
// A successful create call is never treated as approval.

const NAME_RE = /^[a-z0-9_]+$/;
const CATEGORIES = new Set(['MARKETING', 'UTILITY', 'AUTHENTICATION']);
const HEADER_FORMATS = new Set(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']);

export function variableIndexes(text) {
    const found = new Set();
    const re = /\{\{(\d+)\}\}/g;
    let match = re.exec(String(text || ''));
    while (match) {
        found.add(Number(match[1]));
        match = re.exec(String(text || ''));
    }
    return [...found].sort((a, b) => a - b);
}

function sequential(indexes) {
    return indexes.every((value, index) => value === index + 1);
}

export function validateTemplateDraft(draft) {
    const errors = [];
    const name = String(draft?.name || '').trim();
    const category = String(draft?.category || '').trim().toUpperCase();
    const language = String(draft?.language || '').trim();
    const body = String(draft?.body || '');
    const footer = String(draft?.footer || '');
    const header = draft?.header || null;
    const buttons = Array.isArray(draft?.buttons) ? draft.buttons : [];

    if (!NAME_RE.test(name)) errors.push('Template name must be lowercase letters, numbers, and underscores.');
    if (!CATEGORIES.has(category)) errors.push('Category must be MARKETING, UTILITY, or AUTHENTICATION.');
    if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(language)) errors.push('Language must look like en or en_US.');
    if (!body.trim()) errors.push('Body text is required.');
    if (body.length > 1024) errors.push('Body must be 1024 characters or fewer.');
    if (footer.length > 60) errors.push('Footer must be 60 characters or fewer.');

    const bodyVars = variableIndexes(body);
    if (!sequential(bodyVars)) errors.push('Body variables must be {{1}}, {{2}}, … with no gaps.');
    if (header?.text && variableIndexes(header.text).length) {
        errors.push('Header variables are not supported. Keep the header static.');
    }
    if (footer && variableIndexes(footer).length) errors.push('Footer cannot contain variables.');

    if (header) {
        const format = String(header.format || 'TEXT').toUpperCase();
        if (!HEADER_FORMATS.has(format)) errors.push('Header format must be TEXT, IMAGE, VIDEO, or DOCUMENT.');
        if (format === 'TEXT' && String(header.text || '').length > 60) errors.push('Header text must be 60 characters or fewer.');
        if (format !== 'TEXT' && !header.exampleUrl) errors.push('Media headers need a public example URL for Meta.');
    }

    if (buttons.length > 10) errors.push('A template can have at most 10 buttons.');
    const samples = Array.isArray(draft?.examples) ? draft.examples.map((value) => String(value ?? '').trim()) : [];
    if (samples.length < bodyVars.length || samples.slice(0, bodyVars.length).some((value) => !value)) {
        errors.push('Each body variable needs an example value before it can be submitted.');
    }

    buttons.forEach((button, index) => {
        const type = String(button?.type || '').toUpperCase();
        const text = String(button?.text || '').trim();
        if (!text || text.length > 25) errors.push(`Button ${index + 1} text must be 1–25 characters.`);
        if (variableIndexes(text).length) errors.push(`Button ${index + 1} cannot contain variables.`);
        if (type === 'URL') {
            if (!/^https:\/\//.test(String(button.url || ''))) errors.push(`Button ${index + 1} needs an https URL.`);
            if (variableIndexes(button.url).length) errors.push(`Button ${index + 1} URL cannot contain variables.`);
        } else if (type === 'PHONE_NUMBER') {
            if (!/^\+\d{8,15}$/.test(String(button.phoneNumber || ''))) {
                errors.push(`Button ${index + 1} needs a phone number in E.164 format.`);
            }
        } else if (type !== 'QUICK_REPLY') {
            errors.push(`Button ${index + 1} type must be QUICK_REPLY, URL, or PHONE_NUMBER.`);
        }
    });

    return { ok: errors.length === 0, errors, bodyVars };
}

export function mapMetaTemplateStatus(status) {
    switch (String(status || '').toUpperCase()) {
        case 'APPROVED': return 'approved';
        case 'REJECTED': return 'rejected';
        case 'PAUSED': return 'paused';
        case 'DISABLED': return 'disabled';
        case 'IN_APPEAL':
        case 'IN_REVIEW': return 'in_review';
        case 'PENDING': return 'pending';
        default: return 'pending';
    }
}

export function toMetaCreatePayload(draft) {
    const components = [];
    if (draft.header) {
        const format = String(draft.header.format || 'TEXT').toUpperCase();
        const header = { type: 'HEADER', format };
        if (format === 'TEXT') header.text = draft.header.text || '';
        else header.example = { header_url: [draft.header.exampleUrl] };
        components.push(header);
    }
    const body = { type: 'BODY', text: draft.body };
    const examples = (draft.examples || []).map((value) => String(value));
    if (examples.length) body.example = { body_text: [examples] };
    components.push(body);
    if (draft.footer) components.push({ type: 'FOOTER', text: draft.footer });
    if (draft.buttons?.length) {
        components.push({
            type: 'BUTTONS',
            buttons: draft.buttons.map((button) => {
                const type = String(button.type).toUpperCase();
                if (type === 'URL') return { type, text: button.text, url: button.url };
                if (type === 'PHONE_NUMBER') return { type, text: button.text, phone_number: button.phoneNumber };
                return { type: 'QUICK_REPLY', text: button.text };
            }),
        });
    }
    return {
        name: draft.name,
        language: draft.language,
        category: String(draft.category).toUpperCase(),
        components,
    };
}

export function fillTemplate(text, values) {
    return String(text || '').replace(/\{\{(\d+)\}\}/g, (_, index) => {
        const value = values?.[Number(index) - 1];
        return value == null || value === '' ? `{{${index}}}` : String(value);
    });
}

export function campaignIsSendable(template) {
    return Boolean(
        template
        && template.status === 'approved'
        && String(template.category).toUpperCase() === 'MARKETING'
    );
}
