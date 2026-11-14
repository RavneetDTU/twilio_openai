// Small CSV reader for contact import. Handles quoted commas and CRLF.
// No extra dependency — the backend does not already ship a CSV parser.

export function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;
    const src = String(text || '').replace(/^\uFEFF/, '');

    for (let i = 0; i < src.length; i += 1) {
        const char = src[i];
        const next = src[i + 1];
        if (inQuotes) {
            if (char === '"' && next === '"') {
                cell += '"';
                i += 1;
            } else if (char === '"') {
                inQuotes = false;
            } else {
                cell += char;
            }
            continue;
        }
        if (char === '"') {
            inQuotes = true;
        } else if (char === ',') {
            row.push(cell.trim());
            cell = '';
        } else if (char === '\n') {
            row.push(cell.trim());
            cell = '';
            if (row.some((value) => value !== '')) rows.push(row);
            row = [];
        } else if (char !== '\r') {
            cell += char;
        }
    }
    row.push(cell.trim());
    if (row.some((value) => value !== '')) rows.push(row);
    if (rows.length === 0) return { headers: [], records: [] };

    const headers = rows[0].map((header) => header.trim());
    const records = rows.slice(1).map((values, index) => {
        const record = { __row: index + 2 };
        headers.forEach((header, col) => {
            record[header] = values[col] ?? '';
        });
        return record;
    });
    return { headers, records };
}

export function mapRow(record, mapping) {
    const pick = (key) => {
        const column = mapping?.[key];
        if (!column) return '';
        return record[column] ?? '';
    };
    return {
        row: record.__row,
        name: String(pick('name') || '').trim(),
        phone: String(pick('phone') || '').trim(),
        email: String(pick('email') || '').trim(),
        optIn: pick('optIn'),
        source: String(pick('source') || '').trim(),
        tags: String(pick('tags') || '').split(/[|;]/).map((tag) => tag.trim()).filter(Boolean),
        warehouse: String(pick('warehouse') || '').trim(),
        city: String(pick('city') || '').trim(),
    };
}
