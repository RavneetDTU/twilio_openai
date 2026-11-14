// Marketing persistence. Firestore in production, the same methods in memory
// for tests. Existing bookings, call logs, and tenants are not written here.

const COLLECTIONS = {
    contacts: 'marketingContacts',
    templates: 'marketingTemplates',
    campaigns: 'marketingCampaigns',
    recipients: 'marketingRecipients',
    messages: 'marketingMessages',
    conversations: 'marketingConversations',
    events: 'marketingWebhookEvents',
    suppressions: 'marketingSuppressions',
    settings: 'marketingSettings',
    audit: 'marketingAudit',
};

function matches(doc, filters) {
    return filters.every((filter) => {
        const value = doc?.[filter.field];
        if (filter.op === '==') return value === filter.value;
        if (filter.op === 'array-contains') return Array.isArray(value) && value.includes(filter.value);
        if (filter.op === 'in') return Array.isArray(filter.value) && filter.value.includes(value);
        return false;
    });
}

function api(adapter) {
    return {
        get: (col, id) => adapter.get(col, id),
        put: (col, id, data) => adapter.put(col, id, data),
        delete: (col, id) => adapter.delete(col, id),
        updateIf: (col, id, pred, patch) => adapter.updateIf(col, id, pred, patch),
        list: (col, filters = []) => adapter.list(col, filters),
        query: (col, options) => adapter.query(col, options),
        count: (col, filters = []) => adapter.count(col, filters),
    };
}

function compare(left, right) {
    if (left == null && right == null) return 0;
    if (left == null) return -1;
    if (right == null) return 1;
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    return String(left).localeCompare(String(right));
}

function applyFilters(docs, filters) {
    return docs.filter((doc) => matches(doc, filters));
}

function runQuery(docs, { filters = [], orderBy, limit, offset = 0, startAfter } = {}) {
    let rows = applyFilters(docs, filters);
    if (orderBy?.field) {
        const direction = orderBy.direction === 'desc' ? -1 : 1;
        rows.sort((a, b) => direction * compare(a[orderBy.field], b[orderBy.field]));
    }
    if (startAfter != null && orderBy?.field) {
        const cursor = String(startAfter);
        const index = rows.findIndex((row) => String(row[orderBy.field]) === cursor);
        rows = index >= 0 ? rows.slice(index + 1) : rows;
    }
    const start = Math.max(0, Number(offset) || 0);
    const end = limit ? start + limit : undefined;
    return rows.slice(start, end);
}

export function createMemoryMarketingStore() {
    const maps = Object.fromEntries(Object.keys(COLLECTIONS).map((name) => [name, new Map()]));
    return api({
        async get(col, id) {
            const doc = maps[col].get(id);
            return doc ? structuredClone(doc) : null;
        },
        async put(col, id, data) {
            maps[col].set(id, structuredClone({ ...data, id }));
        },
        async delete(col, id) {
            maps[col].delete(id);
        },
        async updateIf(col, id, pred, patch) {
            const current = maps[col].get(id);
            if (!current || !pred(current)) return null;
            const next = { ...current, ...patch, id };
            maps[col].set(id, next);
            return structuredClone(next);
        },
        async list(col, filters = []) {
            return [...maps[col].values()]
                .filter((doc) => matches(doc, filters))
                .map((doc) => structuredClone(doc));
        },
        async query(col, options = {}) {
            return runQuery([...maps[col].values()], options).map((doc) => structuredClone(doc));
        },
        async count(col, filters = []) {
            return [...maps[col].values()].filter((doc) => matches(doc, filters)).length;
        },
    });
}

export function createFirestoreMarketingStore(db) {
    const ref = (col) => db.collection(COLLECTIONS[col]);
    return api({
        async get(col, id) {
            const snap = await ref(col).doc(String(id)).get();
            return snap.exists ? { id: snap.id, ...snap.data() } : null;
        },
        async put(col, id, data) {
            await ref(col).doc(String(id)).set({ ...data, id: String(id) });
        },
        async delete(col, id) {
            await ref(col).doc(String(id)).delete();
        },
        async updateIf(col, id, pred, patch) {
            const docRef = ref(col).doc(String(id));
            return db.runTransaction(async (tx) => {
                const snap = await tx.get(docRef);
                if (!snap.exists) return null;
                const current = { id: snap.id, ...snap.data() };
                if (!pred(current)) return null;
                const next = { ...current, ...patch, id: snap.id };
                tx.set(docRef, next);
                return next;
            });
        },
        async list(col, filters = []) {
            let query = ref(col);
            const local = [];
            filters.forEach((filter) => {
                if (filter.op === '==' || filter.op === 'array-contains' || filter.op === 'in') {
                    query = query.where(filter.field, filter.op, filter.value);
                } else {
                    local.push(filter);
                }
            });
            const snap = await query.get();
            const docs = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
            return local.length ? docs.filter((doc) => matches(doc, local)) : docs;
        },
        async query(col, { filters = [], orderBy, limit, offset = 0, startAfter } = {}) {
            const filtered = () => {
                let query = ref(col);
                const local = [];
                filters.forEach((filter) => {
                    if (filter.op === '==' || filter.op === 'array-contains' || filter.op === 'in') {
                        query = query.where(filter.field, filter.op, filter.value);
                    } else {
                        local.push(filter);
                    }
                });
                return { query, local };
            };
            try {
                let { query, local } = filtered();
                if (orderBy?.field) query = query.orderBy(orderBy.field, orderBy.direction === 'desc' ? 'desc' : 'asc');
                if (startAfter != null) query = query.startAfter(startAfter);
                else if (offset) query = query.offset(offset);
                if (limit) query = query.limit(limit);
                const snap = await query.get();
                const docs = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
                return local.length ? docs.filter((doc) => matches(doc, local)) : docs;
            } catch (error) {
                if (!/requires an index/i.test(error?.message || '')) throw error;
                const snap = await filtered().query.get();
                const docs = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
                return runQuery(docs, { filters, orderBy, limit, offset, startAfter });
            }
        },
        async count(col, filters = []) {
            let query = ref(col);
            filters.forEach((filter) => {
                if (filter.op === '==' || filter.op === 'array-contains' || filter.op === 'in') {
                    query = query.where(filter.field, filter.op, filter.value);
                }
            });
            const snap = await query.count().get();
            return snap.data().count;
        },
    });
}

export const MARKETING_COLLECTIONS = COLLECTIONS;
