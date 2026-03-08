import * as http from 'http';

const defaultHeaders = {
    'Content-Type': 'application/json',
    'User-Agent': 'obsidian/zotero',
    'Accept': 'application/json',
    'Connection': 'keep-alive',
};

const ZOTERO_HOST_CANDIDATES = [
    'http://127.0.0.1:23119',
    'http://localhost:23119',
    'http://[::1]:23119',
];

const JSON_RPC_PATH = '/better-bibtex/json-rpc';

const baseOptions = {
    url: `http://localhost:23119${JSON_RPC_PATH}`,
    hostname: 'localhost',
    port: 23119,
    path: JSON_RPC_PATH,
    method: 'POST',
    contentType: 'application/json',
    headers: defaultHeaders
};

type JsonObject = Record<string, unknown>;
type JsonRpcResponse = {
    jsonrpc?: string;
    result?: unknown;
    error?: { message?: string };
};

interface ZoteroCollection {
    key: string;
    name: string;
    parentCollection: string | false | null;
}

interface ZoteroLibraryGroup {
    id: string;
    name: string;
    collections: ZoteroCollection[];
}

interface LocationResult {
    libraryId: string;
    libraryName: string;
    collectionId: string | null;
}

let resolvedJsonRpcUrl: string | null = null;
const ITEM_KEY_RE = /^[A-Z0-9]{8}$/i;

function canonicalCitekey(key: string): string {
    return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function looksLikeItemKey(value: string): boolean {
    return ITEM_KEY_RE.test(value.trim());
}

function originFromUrl(url: string): string {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
}

function candidateJsonRpcUrls(preferred?: string): string[] {
    const urls: string[] = [];
    if (preferred && preferred.trim().length > 0) {
        urls.push(preferred.trim());
    }
    for (const host of ZOTERO_HOST_CANDIDATES) {
        urls.push(`${host}${JSON_RPC_PATH}`);
    }
    const uniq: string[] = [];
    const seen = new Set<string>();
    for (const u of urls) {
        if (seen.has(u)) continue;
        seen.add(u);
        uniq.push(u);
    }
    return uniq;
}

async function nodeHttpRequest(url: string, method: 'GET' | 'POST', headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> {
    return await new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const req = http.request({
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port ? Number(parsed.port) : 80,
            path: `${parsed.pathname}${parsed.search}`,
            method,
            headers,
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
            });
            res.on('end', () => {
                resolve({
                    status: res.statusCode ?? 0,
                    text: Buffer.concat(chunks).toString('utf8'),
                });
            });
        });

        req.on('error', reject);

        if (body && body.length > 0) {
            req.write(body);
        }
        req.end();
    });
}

async function probeJsonRpcUrl(url: string): Promise<boolean> {
    try {
        const req = await nodeHttpRequest(url, 'POST', defaultHeaders, JSON.stringify({
            jsonrpc: '2.0',
            method: 'api.ready',
            params: []
        }));
        if (req.status !== 200) return false;
        const payload = JSON.parse(req.text) as JsonRpcResponse;
        return !!payload && typeof payload === 'object' && 'result' in payload;
    } catch (_err) {
        return false;
    }
}

async function resolveJsonRpcUrl(preferred?: string): Promise<string> {
    if (resolvedJsonRpcUrl) {
        return resolvedJsonRpcUrl;
    }
    const candidates = candidateJsonRpcUrls(preferred);
    for (const candidate of candidates) {
        if (await probeJsonRpcUrl(candidate)) {
            resolvedJsonRpcUrl = candidate;
            return candidate;
        }
    }
    // Keep backward compatible default even if probe failed.
    resolvedJsonRpcUrl = candidates[0];
    return resolvedJsonRpcUrl;
}

export function isLibraryScopePath(collectionPath:string): boolean {
    const parts = collectionPath.split("/").map((segment) => segment.trim()).filter((segment) => segment.length > 0);
    if (parts.length === 1) return true;
    if (parts.length === 2 && parts[1] === '*') return true;
    return false;
}

async function makeJsonRpcHttpRequest(options:typeof baseOptions, dataStr:string) {
    const candidates = candidateJsonRpcUrls(resolvedJsonRpcUrl ?? options?.url);
    let lastError: unknown = null;

    for (const rpcUrl of candidates) {
        try {
            const req = await nodeHttpRequest(rpcUrl, 'POST', defaultHeaders, dataStr);
            const reqJson = JSON.parse(req.text) as JsonRpcResponse;
            if (req.status !== 200) {
                throw Error(`Zotero request failed with status ${req.status}`);
            }
            if (reqJson?.error?.message) {
                throw Error(reqJson.error.message);
            }

            // Better BibTeX has returned both wrapped and unwrapped json-rpc payloads across versions.
            const result = reqJson.result;
            if (Array.isArray(result) && result.length >= 3 && String(result[0]) === '200') {
                const payload = result[2];
                if (typeof payload === 'string') {
                    try {
                        resolvedJsonRpcUrl = rpcUrl;
                        return JSON.parse(payload);
                    } catch (_error) {
                        resolvedJsonRpcUrl = rpcUrl;
                        return payload;
                    }
                }
                resolvedJsonRpcUrl = rpcUrl;
                return payload;
            }

            if (typeof reqJson === 'object' && 'result' in reqJson) {
                resolvedJsonRpcUrl = rpcUrl;
                return result;
            }

            resolvedJsonRpcUrl = rpcUrl;
            return reqJson as unknown;
        } catch (err) {
            lastError = err;
            continue;
        }
    }

    throw (lastError ?? Error('Zotero JSON-RPC request failed for all endpoint variants.'));
}


async function makeHttpRequest(options: Record<string, unknown>, data:string) {
    const url = typeof options.url === 'string' ? options.url : '';
    if (!url) {
        throw Error('HTTP request missing url');
    }
    const headers = (options.headers ?? {}) as Record<string, string>;
    const req = await nodeHttpRequest(url, data && data.length > 0 ? 'POST' : 'GET', headers, data);
    if (req.status < 200 || req.status >= 300) {
        throw Error(`Request failed, status ${req.status}`);
    }
    return req.text;
}


export async function locateCollection(collectionPath:string) {
    const jsonRpcData = {
        jsonrpc: "2.0",
        method: "user.groups",
        params: [true]
    };

    const result = await makeJsonRpcHttpRequest(baseOptions, JSON.stringify(jsonRpcData)) as ZoteroLibraryGroup[];

    const plist = collectionPath.split("/").map((segment) => segment.trim()).filter((segment) => segment.length > 0);
    const lib = plist[0];
    const after = plist.slice(1);
    if (!lib) {
        throw Error("Invalid collection path. Expected format: Library[/Collection[/Subcollection]]");
    }

    const matchedLib = result.find((group: ZoteroLibraryGroup) => group.name === lib);
    if (!matchedLib) {
        throw Error(`Unable to find Zotero library "${lib}".`);
    }
    const matchedLibId = String(matchedLib.id);

    // Library-wide scope: "My Library" or "My Library/*"
    if (after.length === 0 || (after.length === 1 && after[0] === '*')) {
        return { libraryId: matchedLibId, libraryName: matchedLib.name, collectionId: null };
    }

    const allCollections = matchedLib.collections;
    let parentKey: string | false | null = false;
    let matchedChildCollectionKey: string | null = null;
    for (const cname of after) {
        const current = allCollections.find((coll: ZoteroCollection) => {
            const isTop = parentKey === false || parentKey === null;
            if (isTop) {
                return !coll.parentCollection && coll.name === cname;
            }
            return coll.parentCollection === parentKey && coll.name === cname;
        });

        if (!current) {
            throw Error(`Unable to find Zotero collection path segment "${cname}".`);
        }
        matchedChildCollectionKey = current.key;
        parentKey = current.key;
    }

    return { libraryId: matchedLibId, libraryName: matchedLib.name, collectionId: matchedChildCollectionKey };
}

async function getLibraryItemSearch(libraryId:string): Promise<JsonObject[]> {
    const jsonRpcData = {
        jsonrpc: "2.0",
        method: "item.search",
        params: [[], libraryId]
    };

    const result = await makeJsonRpcHttpRequest(baseOptions, JSON.stringify(jsonRpcData));
    if (!Array.isArray(result)) {
        return [];
    }
    return result.map((item) => (item ?? {}) as JsonObject);
}

async function searchItems(terms: string, library: string): Promise<JsonObject[]> {
    const jsonRpcData = {
        jsonrpc: "2.0",
        method: "item.search",
        params: [terms, library]
    };

    const result = await makeJsonRpcHttpRequest(baseOptions, JSON.stringify(jsonRpcData));
    if (!Array.isArray(result)) {
        return [];
    }
    return result.map((item) => (item ?? {}) as JsonObject);
}

export async function searchItemsInLibrary(terms: string, library: string): Promise<JsonObject[]> {
    return searchItems(terms, library);
}

function extractItemLookupRef(item: JsonObject, libraryId:string): string | null {
    const refCandidates = [item.itemKey, item.key];
    for (const candidate of refCandidates) {
        if (typeof candidate === 'string' && looksLikeItemKey(candidate)) {
            return `${libraryId}:${candidate.toUpperCase()}`;
        }
    }

    const itemId = item.id;
    if (typeof itemId === 'string') {
        const parsed = itemId.match(/items\/([A-Z0-9]{8})/);
        if (parsed?.[1]) {
            return `${libraryId}:${parsed[1]}`;
        }
    }
    return null;
}

function extractItemKey(item: JsonObject): string | null {
    const keyCandidates = [item.itemKey, item.key];
    for (const candidate of keyCandidates) {
        if (typeof candidate === 'string' && looksLikeItemKey(candidate)) {
            return candidate.toUpperCase();
        }
    }

    const itemId = item.id;
    if (typeof itemId === 'string') {
        const parsed = itemId.match(/items\/([A-Z0-9]{8})/);
        if (parsed?.[1]) {
            return parsed[1];
        }
    }
    return null;
}

async function getCitationkeysForItemRefs(itemRefs:string[]): Promise<string[]> {
    if (itemRefs.length === 0) {
        return [];
    }

    const jsonRpcData = {
        jsonrpc: "2.0",
        method: "item.citationkey",
        params: [itemRefs]
    };

    const result = await makeJsonRpcHttpRequest(baseOptions, JSON.stringify(jsonRpcData));
    if (!result || typeof result !== 'object') {
        return [];
    }

    return Object.values(result as Record<string, unknown>)
        .filter((citekey): citekey is string => typeof citekey === 'string' && citekey.trim().length > 0);
}

async function getCitationkeyMapForItemRefs(itemRefs:string[]): Promise<Record<string, string>> {
    if (itemRefs.length === 0) {
        return {};
    }

    const jsonRpcData = {
        jsonrpc: "2.0",
        method: "item.citationkey",
        params: [itemRefs]
    };

    const result = await makeJsonRpcHttpRequest(baseOptions, JSON.stringify(jsonRpcData));
    if (!result || typeof result !== 'object') {
        return {};
    }
    return result as Record<string, string>;
}

export async function resolveCitekeysToItems(citeKeys:string[], libraryId:string): Promise<Map<string, JsonObject>> {
    const result = new Map<string, JsonObject>();
    for (const cite of citeKeys) {
        try {
            const searchResults = await searchItems(cite, libraryId);
            if (!Array.isArray(searchResults) || searchResults.length === 0) continue;

            const refsByIndex = searchResults.map((item) => extractItemLookupRef(item, libraryId));
            const refs = refsByIndex.filter((ref): ref is string => typeof ref === 'string');
            const keyMap = await getCitationkeyMapForItemRefs(refs);

            let matched: JsonObject | null = null;
            let matchedCitekey: string | null = null;
            for (let i = 0; i < searchResults.length; i++) {
                const ref = refsByIndex[i];
                if (!ref) continue;
                const key = keyMap[ref];
                if (typeof key !== 'string') continue;
                if (key === cite || canonicalCitekey(key) === canonicalCitekey(cite)) {
                    matched = searchResults[i];
                    matchedCitekey = key;
                    break;
                }
            }

            if (matched) {
                const normalized = normalizeExportItems([matched])[0];
                if (matchedCitekey) {
                    normalized.id = matchedCitekey;
                    normalized['citation-key'] = matchedCitekey;
                }
                result.set(cite, normalized);
            }
        } catch (_err) {
            continue;
        }
    }
    return result;
}

const libraryQueryCache = new Map<string, { ts: number; rows: { id: string; title: string; meta?: string }[] }>();
const LIBRARY_QUERY_CACHE_MS = 30_000;
const localApiIndexCache = new Map<string, { ts: number; rows: JsonObject[] }>();
const LOCAL_API_INDEX_CACHE_MS = 5 * 60_000;
const LOCAL_API_PAGE_SIZE = 100;
const LOCAL_API_MAX_SCAN = 50_000;

function localScopeKey(collectionPath: string): string {
    const libraryName = collectionPath.split('/').map((segment) => segment.trim()).filter((segment) => segment.length > 0)[0] || 'My Library';
    return libraryName;
}

function parseYearFromDateString(dateRaw: string): string {
    const m = dateRaw.match(/(19|20)\d{2}/);
    return m?.[0] ?? '';
}

function normalizeLocalApiTopItem(entry: Record<string, unknown>): JsonObject | null {
    if (!isTopLevelLocalApiItem(entry)) return null;
    const itemKey = extractLocalApiItemKey(entry);
    const citekeys = extractLocalApiCitationKeys(entry);
    const citekey = citekeys[0];
    if (!citekey) return null;

    const data = (entry.data ?? {}) as Record<string, unknown>;
    const route = parseRouteFromLocalApiEntry(entry);
    const libraryIdHint = route?.kind === 'groups' ? route.ownerId : '1';
    const zoteroSelect = itemKey ? zoteroSelectUri(libraryIdHint, itemKey) : '';

    const dateRaw = typeof data.date === 'string' ? data.date : '';
    const parsedYear = parseYearFromDateString(dateRaw);
    const issued = parsedYear ? { 'date-parts': [[Number(parsedYear)]] } : undefined;

    const publicationTitle = typeof data.publicationTitle === 'string' ? data.publicationTitle : '';
    const journalAbbr = typeof data.journalAbbreviation === 'string' ? data.journalAbbreviation : '';
    const url = typeof data.url === 'string' ? data.url : '';

    const normalized: JsonObject = {
        ...data,
        id: citekey,
        'citation-key': citekey,
        itemKey: itemKey ?? data.key,
        zotero: zoteroSelect || undefined,
        zoteroItemID: zoteroSelect || undefined,
        type: typeof data.itemType === 'string' ? data.itemType : data.type,
    };
    if (issued) {
        normalized.issued = issued;
        normalized.year = parsedYear;
    }
    if (publicationTitle && !normalized['container-title']) {
        normalized['container-title'] = publicationTitle;
    }
    if (journalAbbr && !normalized['container-title-short']) {
        normalized['container-title-short'] = journalAbbr;
    }
    if (url && !normalized.URL) {
        normalized.URL = url;
    }

    return normalized;
}

async function loadLocalApiLibraryIndex(collectionPath: string): Promise<JsonObject[]> {
    const scope = localScopeKey(collectionPath);
    const cached = localApiIndexCache.get(scope);
    if (cached && (Date.now() - cached.ts) < LOCAL_API_INDEX_CACHE_MS) {
        return cached.rows;
    }

    const rows: JsonObject[] = [];
    const seenByCanonical = new Set<string>();
    let start = 0;
    let lastError: unknown = null;

    while (start < LOCAL_API_MAX_SCAN) {
        const pagePathCandidates = [
            `/api/users/0/items/top?format=json&limit=${LOCAL_API_PAGE_SIZE}&start=${start}`,
            `/api/library/items/top?format=json&limit=${LOCAL_API_PAGE_SIZE}&start=${start}`,
        ];

        let pageRows: unknown[] | null = null;
        for (const pagePath of pagePathCandidates) {
            try {
                pageRows = await requestLocalApiJson(pagePath);
                break;
            } catch (err) {
                lastError = err;
                continue;
            }
        }
        if (!pageRows) {
            if (start === 0 && lastError) {
                throw lastError;
            }
            break;
        }
        if (pageRows.length === 0) break;

        for (const raw of pageRows) {
            if (!raw || typeof raw !== 'object') continue;
            const normalized = normalizeLocalApiTopItem(raw as Record<string, unknown>);
            if (!normalized) continue;
            const id = typeof normalized.id === 'string' ? normalized.id : '';
            if (!id) continue;
            const canonical = canonicalCitekey(id);
            if (seenByCanonical.has(canonical)) continue;
            seenByCanonical.add(canonical);
            rows.push(normalized);
        }

        if (pageRows.length < LOCAL_API_PAGE_SIZE) break;
        // Use actual page length to avoid skipping/early-stop when API caps limit.
        start += pageRows.length;
    }

    localApiIndexCache.set(scope, { ts: Date.now(), rows });
    return rows;
}

export async function resolveCitekeysToItemsViaLocalApi(citeKeys: string[], collectionPath: string = 'My Library'): Promise<Map<string, JsonObject>> {
    const result = new Map<string, JsonObject>();
    if (!citeKeys.length) return result;

    const rows = await loadLocalApiLibraryIndex(collectionPath);
    if (!rows.length) return result;

    const byCanonical = new Map<string, JsonObject>();
    for (const row of rows) {
        const id = typeof row.id === 'string' ? row.id : '';
        if (!id) continue;
        const canonical = canonicalCitekey(id);
        if (!byCanonical.has(canonical)) {
            byCanonical.set(canonical, row);
        }
    }

    for (const cite of citeKeys) {
        const found = byCanonical.get(canonicalCitekey(cite));
        if (found) {
            result.set(cite, found);
        }
    }

    return result;
}

async function exportLibrary(libraryId:string, _libraryName:string, bibFormat:string = 'json') {
    if (bibFormat !== 'json') {
        throw Error("Library-wide mode currently supports json format only.");
    }

    const searchResults = await getLibraryItemSearch(libraryId);
    const refsByIndex = searchResults.map((item) => extractItemLookupRef(item, libraryId));
    const refs = refsByIndex.filter((ref): ref is string => typeof ref === 'string');
    const keyMap = await getCitationkeyMapForItemRefs(refs);

    const rows = searchResults
        .map((item, idx) => {
            const ref = refsByIndex[idx];
            const cite = ref ? keyMap[ref] : null;
            const original = item as JsonObject;
            const originalId = typeof original.id === 'string' ? original.id : '';
            return {
                ...original,
                itemKey: extractItemKey(original) ?? original.itemKey,
                zoteroItemID: originalId && originalId.startsWith('http') ? originalId : undefined,
                id: cite ?? extractCitekey(item as JsonObject),
            };
        })
        .filter((item) => typeof item.id === 'string' && item.id.length > 0);

    return rows as JsonObject[];
}


export async function exportCollection(collectionId:string, libraryId:string, bibFormat:string = 'betterbibtex') {

	const url_path = `/better-bibtex/collection?/${libraryId}/${collectionId}.${bibFormat}`;
    const rpcUrl = await resolveJsonRpcUrl(baseOptions.url);
    const origin = originFromUrl(rpcUrl);
    const url = `${origin}${url_path}&exportNotes=true`;

	const options = {
        url: url,
		hostname: 'localhost',
		port: 23119,
		path: url_path,
		method: 'GET',
		headers: {
			'Content-Type': 'application/json',
			},
	};

    try {
        const responseStr = await makeHttpRequest(options, '')

        const responseJson = JSON.parse(responseStr) as unknown[];

        return responseJson;

    }
    catch (error) {
        if (error.message === 'Request failed, status 404'){
            throw Error("Unable to find Zotero collection.")
        }
        throw error;
    }


}

export async function bibliography(citeKeys:string[], library:string='', style:string, contentType:string='text', quickCopy:boolean=false) {
    
    const format = {
                    contentType: contentType, // can be 'html'
                    locale: '',
                    id: style,
                    quickCopy: quickCopy,
                    }

    const jsonRpcData = {
        jsonrpc: "2.0",
        method: "item.bibliography",
        params: [citeKeys, format, library]
    };

    const result = await makeJsonRpcHttpRequest(baseOptions, JSON.stringify(jsonRpcData));

    return result;

}


export async function exportItems(citeKeys:string[], libraryID:string, translator:string="json") {

    try { 
        
        const jsonRpcData = {
            jsonrpc: "2.0",
            method: "item.export",
            params: [citeKeys, translator, libraryID]
        };
    
        let result = await makeJsonRpcHttpRequest(baseOptions, JSON.stringify(jsonRpcData));
        
        if (typeof(result) === 'string') {
            result = JSON.parse(result);
        } else {
            /* result = result; */ // no changes
        };

        return result;

    }
    catch (error) {
        console.error('Error:', error);
        throw error;
    }
        
}

export async function exportItemsNonJSON(citeKeys:string[], libraryID:string, translator:string="yaml") {

    try { 
        
        const jsonRpcData = {
            jsonrpc: "2.0",
            method: "item.export",
            params: [citeKeys, translator, libraryID]
        };
    
        let result = await makeJsonRpcHttpRequest(baseOptions, JSON.stringify(jsonRpcData));
        
        return result;

    }
    catch (error) {
        console.error('Error:', error);
        throw error;
    }
        
}

function zoteroSelectUri(libraryId: string, itemKey: string): string {
    if (libraryId === '1') {
        return `zotero://select/library/items/${itemKey}`;
    }
    return `zotero://select/groups/${libraryId}/items/${itemKey}`;
}

function zoteroOpenPdfUri(libraryId: string, attachmentKey: string): string {
    if (libraryId === '1') {
        return `zotero://open-pdf/library/items/${attachmentKey}`;
    }
    return `zotero://open-pdf/groups/${libraryId}/items/${attachmentKey}`;
}

async function requestLocalApiJson(path: string): Promise<unknown[]> {
    const preferredOrigin = resolvedJsonRpcUrl ? originFromUrl(resolvedJsonRpcUrl) : null;
    const origins = preferredOrigin ? [preferredOrigin, ...ZOTERO_HOST_CANDIDATES] : [...ZOTERO_HOST_CANDIDATES];
    const seen = new Set<string>();
    let lastError: unknown = null;

    for (const origin of origins) {
        if (seen.has(origin)) continue;
        seen.add(origin);
        try {
            const req = await nodeHttpRequest(`${origin}${path}`, 'GET', {
                'Accept': 'application/json',
            });
            if (req.status !== 200) {
                throw Error(`Local Zotero API failed with status ${req.status}`);
            }
            const payload = JSON.parse(req.text) as unknown;
            return Array.isArray(payload) ? payload : [];
        } catch (err) {
            lastError = err;
        }
    }

    throw (lastError ?? Error('Local Zotero API failed for all endpoint variants.'));
}

function parseWebItemRoute(item: JsonObject): { kind: 'users' | 'groups'; ownerId: string; itemKey: string } | null {
    const id = item.id;
    if (typeof id !== 'string') return null;
    const m = id.match(/zotero\.org\/(users|groups)\/([^/]+)\/items\/([A-Z0-9]{8})/i);
    if (!m) return null;
    const kind = m[1].toLowerCase() === 'groups' ? 'groups' : 'users';
    return {
        kind,
        ownerId: m[2],
        itemKey: m[3].toUpperCase(),
    };
}

type AttachmentAnnotation = {
    annotationAuthorName: string;
    annotationColor: string;
    annotationComment: string;
    annotationText: string;
    annotationType: string;
    dateAdded: string;
    dateModified: string;
    itemType: string;
    key: string;
    parentItem: string;
    annotationImagePath?: string;
};

type AttachmentResult = {
    open: string;
    path: string | boolean;
    label?: string;
    annotations?: AttachmentAnnotation[];
};

export type SourceLookupDiagnostics = {
    citekey: string;
    itemKey: string | null;
    libraryId: string | null;
    route: string | null;
    selectUri: string | null;
    childrenCount: number | null;
    attachmentCount: number;
    attachmentLabels: string[];
    resolution: 'hint' | 'local-index-map' | 'local-search' | 'unresolved';
    error?: string;
};

export type AttachmentLookupHint = {
    itemKey?: string;
    zoteroItemID?: string;
    zotero?: string;
    citekey?: string;
    doi?: string;
    title?: string;
};

const ENABLE_LOCAL_API_ANNOTATION_LOOKUP = false;

function normalizeLocalApiAnnotation(entry: Record<string, unknown>): AttachmentAnnotation | null {
    const data = (entry.data ?? {}) as Record<string, unknown>;
    if (data.itemType !== 'annotation') return null;
    const key = typeof data.key === 'string' ? data.key : (typeof entry.key === 'string' ? entry.key : '');
    const parentItem = typeof data.parentItem === 'string' ? data.parentItem : '';
    if (!key || !parentItem) return null;
    const annotation: AttachmentAnnotation = {
        annotationAuthorName: typeof data.annotationAuthorName === 'string' ? data.annotationAuthorName : '',
        annotationColor: typeof data.annotationColor === 'string' ? data.annotationColor : '#ffd400',
        annotationComment: typeof data.annotationComment === 'string' ? data.annotationComment : '',
        annotationText: typeof data.annotationText === 'string' ? data.annotationText : '',
        annotationType: typeof data.annotationType === 'string' ? data.annotationType : 'highlight',
        dateAdded: typeof data.dateAdded === 'string' ? data.dateAdded : '',
        dateModified: typeof data.dateModified === 'string' ? data.dateModified : '',
        itemType: 'annotation',
        key,
        parentItem,
    };
    if (typeof data.annotationImagePath === 'string' && data.annotationImagePath.length > 0) {
        annotation.annotationImagePath = data.annotationImagePath;
    }
    return annotation;
}

function routeFromUri(uri: string): { kind: 'users' | 'groups'; ownerId: string; itemKey: string } | null {
    const web = uri.match(/\/(users|groups)\/([^/]+)\/items\/([A-Z0-9]{8})/i);
    if (web) {
        return {
            kind: web[1].toLowerCase() === 'groups' ? 'groups' : 'users',
            ownerId: web[2],
            itemKey: web[3].toUpperCase(),
        };
    }

    const zoteroGroup = uri.match(/^zotero:\/\/(?:select|open-pdf)\/groups\/([^/]+)\/items\/([A-Z0-9]{8})/i);
    if (zoteroGroup?.[1] && zoteroGroup?.[2]) {
        return {
            kind: 'groups',
            ownerId: zoteroGroup[1],
            itemKey: zoteroGroup[2].toUpperCase(),
        };
    }

    const zoteroLibrary = uri.match(/^zotero:\/\/(?:select|open-pdf)\/library\/items\/([A-Z0-9]{8})/i);
    if (zoteroLibrary?.[1]) {
        return {
            kind: 'users',
            ownerId: '0',
            itemKey: zoteroLibrary[1].toUpperCase(),
        };
    }

    return null;
}

function itemKeyFromHints(hint?: AttachmentLookupHint): string | null {
    if (!hint) return null;
    const direct = typeof hint.itemKey === 'string' ? hint.itemKey.trim() : '';
    if (direct && looksLikeItemKey(direct)) {
        return direct.toUpperCase();
    }

    const uriCandidates = [hint.zoteroItemID, hint.zotero]
        .filter((u): u is string => typeof u === 'string' && u.length > 0);
    for (const uri of uriCandidates) {
        const parsed = uri.match(/items\/([A-Z0-9]{8})/i);
        if (parsed?.[1]) {
            return parsed[1].toUpperCase();
        }
    }
    return null;
}

function routeFromHints(hint?: AttachmentLookupHint): { kind: 'users' | 'groups'; ownerId: string; itemKey: string } | null {
    if (!hint) return null;
    const uriCandidates = [hint.zoteroItemID, hint.zotero]
        .filter((u): u is string => typeof u === 'string' && u.length > 0);
    for (const uri of uriCandidates) {
        const parsed = routeFromUri(uri);
        if (parsed) return parsed;
    }
    return null;
}

function parseRouteFromLocalApiEntry(entry: Record<string, unknown>): { kind: 'users' | 'groups'; ownerId: string; itemKey: string } | null {
    const links = (entry.links ?? {}) as Record<string, unknown>;
    const self = (links.self ?? {}) as Record<string, unknown>;
    const href = typeof self.href === 'string' ? self.href : '';
    if (!href) return null;
    return routeFromUri(href);
}

function extractLocalApiItemKey(entry: Record<string, unknown>): string | null {
    const data = (entry.data ?? {}) as Record<string, unknown>;
    const keyCandidates = [data.key, entry.key];
    for (const candidate of keyCandidates) {
        if (typeof candidate === 'string' && looksLikeItemKey(candidate)) {
            return candidate.toUpperCase();
        }
    }
    return null;
}

function extractLocalApiCitationKeys(entry: Record<string, unknown>): string[] {
    const data = (entry.data ?? {}) as Record<string, unknown>;
    const values: string[] = [];
    const add = (v: unknown) => {
        if (typeof v === 'string' && v.trim().length > 0) values.push(v.trim());
    };

    add(data.citationKey);
    add(data['citation-key']);
    add(data.citekey);

    const extra = typeof data.extra === 'string' ? data.extra : '';
    if (extra) {
        for (const line of extra.split('\n')) {
            const m = line.match(/^\s*citation\s*key\s*:\s*(.+)\s*$/i);
            if (m?.[1]) add(m[1]);
        }
    }

    return Array.from(new Set(values));
}

function extractLocalApiDoi(entry: Record<string, unknown>): string {
    const data = (entry.data ?? {}) as Record<string, unknown>;
    return typeof data.DOI === 'string' ? data.DOI.trim() : '';
}

function extractLocalApiTitle(entry: Record<string, unknown>): string {
    const data = (entry.data ?? {}) as Record<string, unknown>;
    return typeof data.title === 'string' ? data.title : '';
}

function isTopLevelLocalApiItem(entry: Record<string, unknown>): boolean {
    const data = (entry.data ?? {}) as Record<string, unknown>;
    const itemType = typeof data.itemType === 'string' ? data.itemType : '';
    return itemType !== 'attachment' && itemType !== 'note' && itemType !== 'annotation';
}

async function searchItemsViaLocalApi(
    query: string,
    routeHint: { kind: 'users' | 'groups'; ownerId: string; itemKey: string } | null
): Promise<Record<string, unknown>[]> {
    const q = query.trim();
    if (!q) return [];
    const encoded = encodeURIComponent(q);
    const paths: string[] = [];
    const addPath = (base: string) => paths.push(base);

    if (routeHint) {
        addPath(`/api/${routeHint.kind}/${routeHint.ownerId}/items/top?format=json&q=${encoded}&limit=25`);
        addPath(`/api/${routeHint.kind}/${routeHint.ownerId}/items?format=json&q=${encoded}&limit=25`);
    }
    addPath(`/api/users/0/items/top?format=json&q=${encoded}&limit=25`);
    addPath(`/api/users/0/items?format=json&q=${encoded}&limit=25`);
    addPath(`/api/users/local/items/top?format=json&q=${encoded}&limit=25`);
    addPath(`/api/users/local/items?format=json&q=${encoded}&limit=25`);
    addPath(`/api/library/items/top?format=json&q=${encoded}&limit=25`);
    addPath(`/api/library/items?format=json&q=${encoded}&limit=25`);

    const seenPath = new Set<string>();
    const rows: Record<string, unknown>[] = [];
    const seenKey = new Set<string>();
    let successfulRequest = false;
    let lastError: unknown = null;

    for (const path of paths) {
        if (seenPath.has(path)) continue;
        seenPath.add(path);
        try {
            const payload = await requestLocalApiJson(path);
            successfulRequest = true;
            for (const raw of payload) {
                if (!raw || typeof raw !== 'object') continue;
                const entry = raw as Record<string, unknown>;
                const key = extractLocalApiItemKey(entry) || `idx-${rows.length}`;
                if (seenKey.has(key)) continue;
                seenKey.add(key);
                rows.push(entry);
            }
            if (rows.length > 0) {
                return rows;
            }
        } catch (err) {
            lastError = err;
            continue;
        }
    }

    if (!successfulRequest && lastError) {
        throw lastError;
    }
    return rows;
}

async function resolveItemKeyViaLocalApiSearch(
    citeKey: string,
    hint?: AttachmentLookupHint,
    libraryPath: string = 'My Library'
): Promise<{ itemKey: string; route: { kind: 'users' | 'groups'; ownerId: string; itemKey: string } | null; libraryId: string | null } | null> {
    const baseRoute = routeFromHints(hint);
    const normalizedCite = canonicalCitekey(citeKey);
    const sanitizedCite = citeKey.replace(/[^A-Za-z0-9_-]/g, '');
    const hintCite = typeof hint?.citekey === 'string' ? hint.citekey.trim() : '';
    const hintDoi = typeof hint?.doi === 'string' ? hint.doi.trim() : '';
    const hintTitle = typeof hint?.title === 'string' ? hint.title.trim() : '';

    const queryCandidates: Array<{ kind: 'doi' | 'citekey' | 'title'; value: string }> = [];
    if (hintDoi) queryCandidates.push({ kind: 'doi', value: hintDoi });
    if (hintCite) queryCandidates.push({ kind: 'citekey', value: hintCite });
    queryCandidates.push({ kind: 'citekey', value: citeKey });
    if (sanitizedCite && sanitizedCite !== citeKey) queryCandidates.push({ kind: 'citekey', value: sanitizedCite });
    if (hintTitle) queryCandidates.push({ kind: 'title', value: hintTitle.slice(0, 160) });

    // Zotero 8 robust path: resolve from full local API index first.
    try {
        const rows = await loadLocalApiLibraryIndex(libraryPath);
        const byCanonical = new Map<string, JsonObject>();
        for (const row of rows) {
            const id = typeof row.id === 'string' ? row.id : '';
            if (!id) continue;
            const canonical = canonicalCitekey(id);
            if (!byCanonical.has(canonical)) byCanonical.set(canonical, row);
        }

        for (const query of queryCandidates) {
            if (query.kind === 'citekey') {
                const found = byCanonical.get(canonicalCitekey(query.value));
                if (found) {
                    const itemKey = extractItemKey(found);
                    if (itemKey) {
                        const route = routeFromHints({
                            zotero: typeof found.zotero === 'string' ? found.zotero : undefined,
                            zoteroItemID: typeof found.zoteroItemID === 'string' ? found.zoteroItemID : undefined,
                        });
                        const libraryId = route?.kind === 'groups' ? route.ownerId : '1';
                        return { itemKey, route, libraryId };
                    }
                }
                continue;
            }

            if (query.kind === 'doi') {
                const queryDoi = canonicalCitekey(query.value);
                const found = rows.find((row) => {
                    const doi = typeof row.DOI === 'string' ? row.DOI : '';
                    return doi.length > 0 && canonicalCitekey(doi) === queryDoi;
                });
                if (found) {
                    const itemKey = extractItemKey(found);
                    if (itemKey) {
                        const route = routeFromHints({
                            zotero: typeof found.zotero === 'string' ? found.zotero : undefined,
                            zoteroItemID: typeof found.zoteroItemID === 'string' ? found.zoteroItemID : undefined,
                        });
                        const libraryId = route?.kind === 'groups' ? route.ownerId : '1';
                        return { itemKey, route, libraryId };
                    }
                }
                continue;
            }

            const queryTitle = query.value.toLowerCase();
            const found = rows.find((row) => {
                const title = typeof row.title === 'string' ? row.title.toLowerCase() : '';
                return title.length > 0 && title.includes(queryTitle);
            });
            if (found) {
                const itemKey = extractItemKey(found);
                if (itemKey) {
                    const route = routeFromHints({
                        zotero: typeof found.zotero === 'string' ? found.zotero : undefined,
                        zoteroItemID: typeof found.zoteroItemID === 'string' ? found.zoteroItemID : undefined,
                    });
                    const libraryId = route?.kind === 'groups' ? route.ownerId : '1';
                    return { itemKey, route, libraryId };
                }
            }
        }
    } catch (_err) {
        // Ignore and continue to q-based fallback.
    }

    // Legacy fallback: q-based search. In Zotero 8 this may not match citekeys consistently.
    for (const query of queryCandidates) {
        const rows = await searchItemsViaLocalApi(query.value, baseRoute);
        if (!rows.length) continue;

        const topRows = rows.filter((entry) => isTopLevelLocalApiItem(entry));
        const candidates = topRows.length > 0 ? topRows : rows;

        for (const entry of candidates) {
            const itemKey = extractLocalApiItemKey(entry);
            if (!itemKey) continue;

            if (query.kind === 'doi') {
                const doi = extractLocalApiDoi(entry);
                if (doi && canonicalCitekey(doi) === canonicalCitekey(query.value)) {
                    const route = parseRouteFromLocalApiEntry(entry);
                    const libraryId = route?.kind === 'groups' ? route.ownerId : '1';
                    return { itemKey, route, libraryId };
                }
                continue;
            }

            if (query.kind === 'citekey') {
                const keys = extractLocalApiCitationKeys(entry);
                const keyMatched = keys.some((k) => canonicalCitekey(k) === normalizedCite || canonicalCitekey(k) === canonicalCitekey(query.value));
                if (keyMatched) {
                    const route = parseRouteFromLocalApiEntry(entry);
                    const libraryId = route?.kind === 'groups' ? route.ownerId : '1';
                    return { itemKey, route, libraryId };
                }
                continue;
            }

            const title = extractLocalApiTitle(entry).toLowerCase();
            if (title && title.includes(query.value.toLowerCase())) {
                const route = parseRouteFromLocalApiEntry(entry);
                const libraryId = route?.kind === 'groups' ? route.ownerId : '1';
                return { itemKey, route, libraryId };
            }
        }

        // Fallback: DOI query with any top-level result is usually reliable.
        if (query.kind === 'doi') {
            const first = candidates.find((entry) => !!extractLocalApiItemKey(entry));
            if (first) {
                const itemKey = extractLocalApiItemKey(first) as string;
                const route = parseRouteFromLocalApiEntry(first);
                const libraryId = route?.kind === 'groups' ? route.ownerId : '1';
                return { itemKey, route, libraryId };
            }
        }
    }

    return null;
}

async function resolveMatchedItemByCitekey(citeKey: string, libraryId: string): Promise<JsonObject | null> {
    const searchResults = await searchItems(citeKey, libraryId);
    if (!Array.isArray(searchResults) || searchResults.length === 0) {
        return null;
    }

    const refsByIndex = searchResults.map((item) => extractItemLookupRef(item, libraryId));
    const refs = refsByIndex.filter((ref): ref is string => typeof ref === 'string');
    const keyMap = await getCitationkeyMapForItemRefs(refs);

    for (let i = 0; i < searchResults.length; i++) {
        const ref = refsByIndex[i];
        if (!ref) continue;
        const resolved = keyMap[ref];
        if (resolved === citeKey || (typeof resolved === 'string' && canonicalCitekey(resolved) === canonicalCitekey(citeKey))) {
            return searchResults[i];
        }
    }

    for (const item of searchResults) {
        const extracted = extractCitekey(item);
        if (extracted === citeKey || (typeof extracted === 'string' && canonicalCitekey(extracted) === canonicalCitekey(citeKey))) {
            return item;
        }
    }

    return searchResults[0] ?? null;
}

async function getChildrenViaLocalApiCandidates(
    matched: JsonObject | null,
    libraryId: string | null | undefined,
    itemKey: string,
    routeHint: { kind: 'users' | 'groups'; ownerId: string; itemKey: string } | null = null
): Promise<unknown[]> {
    const route = routeHint ?? (matched ? parseWebItemRoute(matched) : null);
    const candidates: string[] = [];
    const addPath = (base: string) => {
        candidates.push(base);
        if (!base.includes('?')) {
            candidates.push(`${base}?format=json`);
        }
    };
    if (route) {
        addPath(`/api/${route.kind}/${route.ownerId}/items/${route.itemKey}/children`);
        if (route.kind === 'users') {
            addPath(`/api/users/${route.ownerId}/items/${route.itemKey}/children`);
        }
    }
    addPath(`/api/users/0/items/${itemKey}/children`);
    addPath(`/api/users/local/items/${itemKey}/children`);
    if (libraryId && libraryId !== '1') {
        addPath(`/api/groups/${libraryId}/items/${itemKey}/children`);
    }
    addPath(`/api/library/items/${itemKey}/children`);

    const seen = new Set<string>();
    let lastError: unknown = null;
    for (const path of candidates) {
        if (seen.has(path)) continue;
        seen.add(path);
        try {
            return await requestLocalApiJson(path);
        } catch (err) {
            lastError = err;
        }
    }
    if (lastError instanceof Error && lastError.message.includes('status 404')) {
        throw Error('Local Zotero API returned 404 for attachment lookup routes. Check Zotero local API availability.');
    }
    throw (lastError ?? Error('No local API candidate path succeeded.'));
}

function routeWithItemKey(
    route: { kind: 'users' | 'groups'; ownerId: string; itemKey: string } | null,
    itemKey: string
): { kind: 'users' | 'groups'; ownerId: string; itemKey: string } | null {
    if (!route) return null;
    return {
        kind: route.kind,
        ownerId: route.ownerId,
        itemKey,
    };
}

function inferLibraryIdHint(
    located: LocationResult | null,
    routeHint: { kind: 'users' | 'groups'; ownerId: string; itemKey: string } | null,
): string | null {
    if (located?.libraryId) return located.libraryId;
    if (!routeHint) return '1';
    if (routeHint.kind === 'groups') return routeHint.ownerId;
    return '1';
}

async function collectAttachmentAnnotationsViaLocalApi(
    attachments: { key: string; linkMode: string; contentType: string; filename: string; title: string }[],
    libraryIdHint: string | null,
    routeHint: { kind: 'users' | 'groups'; ownerId: string; itemKey: string } | null
): Promise<Map<string, AttachmentAnnotation[]>> {
    const annotationsByParent = new Map<string, AttachmentAnnotation[]>();

    for (const attachment of attachments) {
        const attachmentRoute = routeWithItemKey(routeHint, attachment.key);
        let attachmentChildren: unknown[] = [];
        try {
            attachmentChildren = await getChildrenViaLocalApiCandidates(null, libraryIdHint, attachment.key, attachmentRoute);
        } catch (_err) {
            continue;
        }

        for (const child of attachmentChildren) {
            if (!child || typeof child !== 'object') continue;
            const entry = child as Record<string, unknown>;
            const ann = normalizeLocalApiAnnotation(entry);
            if (!ann) continue;
            const grouped = annotationsByParent.get(ann.parentItem) || [];
            grouped.push(ann);
            annotationsByParent.set(ann.parentItem, grouped);
        }
    }

    return annotationsByParent;
}

function isPdfAttachment(attachment: { linkMode: string; contentType: string; filename: string; title: string }): boolean {
    const contentType = attachment.contentType.toLowerCase();
    if (contentType === 'application/pdf') return true;
    const filename = attachment.filename.toLowerCase();
    if (filename.endsWith('.pdf')) return true;
    const title = attachment.title.toLowerCase();
    if (title.endsWith('.pdf') || title.includes('.pdf')) return true;
    return false;
}

async function attachmentsViaLocalApi(citeKey: string, located: LocationResult | null, libraryPath: string, hint?: AttachmentLookupHint): Promise<AttachmentResult[]> {
    let matched: JsonObject | null = null;
    let resolvedLibraryId: string | null = located?.libraryId ?? null;
    const hintedItemKey = itemKeyFromHints(hint);
    if (!hintedItemKey && located?.libraryId) {
        try {
            matched = await resolveMatchedItemByCitekey(citeKey, located.libraryId);
        } catch (_err) {
            matched = null;
        }
    }

    let itemKey = hintedItemKey ?? (matched ? extractItemKey(matched) : null);
    let hintedRoute = routeFromHints(hint) ?? (matched ? parseWebItemRoute(matched) : null);
    if (!itemKey) {
        try {
            const byCitekey = await resolveCitekeysToItemsViaLocalApi([citeKey], libraryPath);
            const localMatched = byCitekey.get(citeKey);
            if (localMatched) {
                itemKey = extractItemKey(localMatched as JsonObject);
            }
        } catch (_err) {
            // ignore and try search fallback below
        }
    }
    if (!itemKey) {
        const localResolved = await resolveItemKeyViaLocalApiSearch(citeKey, hint, libraryPath);
        if (localResolved) {
            itemKey = localResolved.itemKey;
            if (!hintedRoute && localResolved.route) {
                hintedRoute = localResolved.route;
            }
            if (!resolvedLibraryId && localResolved.libraryId) {
                resolvedLibraryId = localResolved.libraryId;
            }
        }
    }
    if (!itemKey) {
        throw Error(`Unable to resolve Zotero item key for citekey ${citeKey}`);
    }
    if (!resolvedLibraryId && hintedRoute?.kind === 'groups') {
        resolvedLibraryId = hintedRoute.ownerId;
    }

    const children = await getChildrenViaLocalApiCandidates(matched, resolvedLibraryId, itemKey, hintedRoute);

    const attachments: { key: string; linkMode: string; contentType: string; filename: string; title: string }[] = [];
    const topLevelAnnotationsByParent = new Map<string, AttachmentAnnotation[]>();

    for (const child of children) {
        if (!child || typeof child !== 'object') continue;
        const entry = child as Record<string, unknown>;
        const data = (entry.data ?? {}) as Record<string, unknown>;
        const itemType = typeof data.itemType === 'string' ? data.itemType : '';

        if (itemType === 'attachment') {
            const key = typeof data.key === 'string' ? data.key : (typeof entry.key === 'string' ? entry.key : '');
            if (!key) continue;
            const linkMode = typeof data.linkMode === 'string' ? data.linkMode : '';
            const contentType = typeof data.contentType === 'string' ? data.contentType : '';
            const filename = typeof data.filename === 'string' ? data.filename : '';
            const title = typeof data.title === 'string' ? data.title : '';
            attachments.push({ key, linkMode, contentType, filename, title });
            continue;
        }

        if (ENABLE_LOCAL_API_ANNOTATION_LOOKUP && itemType === 'annotation') {
            const ann = normalizeLocalApiAnnotation(entry);
            if (!ann) continue;
            const grouped = topLevelAnnotationsByParent.get(ann.parentItem) || [];
            grouped.push(ann);
            topLevelAnnotationsByParent.set(ann.parentItem, grouped);
        }
    }

    const libraryIdHint = inferLibraryIdHint(located, hintedRoute);
    const annotationsByParent = ENABLE_LOCAL_API_ANNOTATION_LOOKUP
        ? await collectAttachmentAnnotationsViaLocalApi(attachments, libraryIdHint, hintedRoute)
        : new Map<string, AttachmentAnnotation[]>();
    if (ENABLE_LOCAL_API_ANNOTATION_LOOKUP) {
        for (const [parent, anns] of topLevelAnnotationsByParent.entries()) {
            const current = annotationsByParent.get(parent) || [];
            annotationsByParent.set(parent, [...current, ...anns]);
        }
    }

    if (attachments.length === 0) {
        return [{
            open: zoteroSelectUri(libraryIdHint ?? '1', itemKey),
            path: true,
            label: 'Open in Zotero',
            annotations: [],
        }];
    }

    const ordered = [...attachments].sort((a, b) => Number(isPdfAttachment(b)) - Number(isPdfAttachment(a)));

    return ordered.map((attachment) => {
        const openUri = isPdfAttachment(attachment)
            ? zoteroOpenPdfUri(libraryIdHint ?? '1', attachment.key)
            : (attachment.linkMode !== 'linked_url'
                ? zoteroOpenPdfUri(libraryIdHint ?? '1', attachment.key)
                : zoteroSelectUri(libraryIdHint ?? '1', attachment.key));
        return {
            open: openUri,
            path: true,
            label: attachment.filename || attachment.title || (isPdfAttachment(attachment) ? 'PDF attachment' : 'Attachment'),
            annotations: annotationsByParent.get(attachment.key) || [],
        };
    });
}

function normalizeRpcAttachmentPayload(result: unknown, citeKey: string): AttachmentResult[] | null {
    if (Array.isArray(result)) {
        return result as AttachmentResult[];
    }
    if (!result || typeof result !== 'object') {
        return null;
    }

    const asObject = result as Record<string, unknown>;
    if (Array.isArray(asObject[citeKey])) {
        return asObject[citeKey] as AttachmentResult[];
    }

    const normalizedCite = canonicalCitekey(citeKey);
    for (const [k, v] of Object.entries(asObject)) {
        if (!Array.isArray(v)) continue;
        if (k === citeKey || canonicalCitekey(k) === normalizedCite) {
            return v as AttachmentResult[];
        }
    }

    if (typeof asObject.open === 'string') {
        const single = asObject as unknown as AttachmentResult;
        return [single];
    }

    return null;
}

async function attachmentsViaRpcVariants(citeKey: string, libraryCandidates: Array<string | number>): Promise<AttachmentResult[]> {
    const positionalCandidates: unknown[][] = [
        [citeKey],
        [citeKey, '*'],
    ];
    for (const library of libraryCandidates) {
        positionalCandidates.unshift([citeKey, library]);
    }
    const namedCandidates: Record<string, unknown>[] = [{ citekey: citeKey }, { citationkey: citeKey }];
    for (const library of libraryCandidates) {
        namedCandidates.unshift({ citekey: citeKey, library });
        namedCandidates.unshift({ citationkey: citeKey, library });
    }

    const methods = ['item.attachments', 'items.attachments', 'citation.attachments'];
    let lastError: unknown = null;
    for (const method of methods) {
        const allCandidates: unknown[] = [...positionalCandidates, ...namedCandidates];
        for (const params of allCandidates) {
            try {
                const jsonRpcData = {
                    jsonrpc: "2.0",
                    method,
                    params,
                };
                const result = await makeJsonRpcHttpRequest(baseOptions, JSON.stringify(jsonRpcData));
                const normalized = normalizeRpcAttachmentPayload(result, citeKey);
                if (normalized) {
                    return normalized;
                }
            } catch (err) {
                lastError = err;
            }
        }
    }
    throw (lastError ?? Error('item.attachments failed for all parameter variants'));
}

export async function attachments(citeKey:string, library:string, hint?: AttachmentLookupHint) {
    let rpcError: unknown = null;
    let localError: unknown = null;
    const hintedItemKey = itemKeyFromHints(hint);
    let selectUri: string | null = hintedItemKey ? `zotero://select/library/items/${hintedItemKey}` : null;
    let located: LocationResult | null = null;

    // Zotero 8 path: local API first.
    try {
        return await attachmentsViaLocalApi(citeKey, null, library, hint);
    } catch (err) {
        localError = err;
    }

    const localErrorMsg = localError instanceof Error ? localError.message : String(localError);
    const shouldTryRpc =
        /ERR_CONNECTION_REFUSED/i.test(localErrorMsg)
        || /status 404/i.test(localErrorMsg)
        || /Local Zotero API/i.test(localErrorMsg)
        || /No local API candidate/i.test(localErrorMsg);

    // RPC fallback only when local API itself looks unreachable.
    if (shouldTryRpc) {
        try {
            if (!located) {
                located = await locateCollection(library);
            }
            const matched = await resolveMatchedItemByCitekey(citeKey, located.libraryId);
            const itemKey = hintedItemKey ?? (matched ? extractItemKey(matched) : null);
            if (itemKey) {
                selectUri = zoteroSelectUri(located.libraryId, itemKey);
            }
            const numericLibraryId = Number(located.libraryId);
            const libraryCandidates: Array<string | number> = [
                located.libraryName,
                located.libraryId,
            ];
            if (Number.isFinite(numericLibraryId) && numericLibraryId > 0) {
                libraryCandidates.push(numericLibraryId);
            }
            return await attachmentsViaRpcVariants(citeKey, libraryCandidates);

        } catch (error) {
            rpcError = error;
        }
    } else {
        rpcError = Error('Skipped RPC fallback (local API reachable but citekey unresolved).');
    }

    const details = [
        `citekey=${citeKey}`,
        `library=${library}`,
        `rpc=${rpcError instanceof Error ? rpcError.message : String(rpcError)}`,
        `fallback=${localError instanceof Error ? localError.message : String(localError)}`
    ].join('; ');
    console.warn(`Zotsidian attachment lookup degraded: ${details}`);

    if (selectUri) {
        return [{
            open: selectUri,
            path: true,
            label: 'Open in Zotero',
            annotations: [],
        }];
    }

    return [];

}

export async function diagnoseSourceLookup(citeKey: string, libraryPath: string, hint?: AttachmentLookupHint): Promise<SourceLookupDiagnostics> {
    let resolution: SourceLookupDiagnostics['resolution'] = 'unresolved';
    let itemKey = itemKeyFromHints(hint);
    let route = routeFromHints(hint);
    let libraryId: string | null = route?.kind === 'groups' ? route.ownerId : '1';

    if (itemKey) {
        resolution = 'hint';
    }

    if (!itemKey) {
        try {
            const byCitekey = await resolveCitekeysToItemsViaLocalApi([citeKey], libraryPath);
            const localMatched = byCitekey.get(citeKey);
            if (localMatched) {
                itemKey = extractItemKey(localMatched as JsonObject);
                route = routeFromHints({
                    zotero: typeof localMatched.zotero === 'string' ? localMatched.zotero : undefined,
                    zoteroItemID: typeof localMatched.zoteroItemID === 'string' ? localMatched.zoteroItemID : undefined,
                });
                libraryId = route?.kind === 'groups' ? route.ownerId : '1';
                resolution = itemKey ? 'local-index-map' : resolution;
            }
        } catch (_err) {
            // ignore and continue
        }
    }

    if (!itemKey) {
        try {
            const resolved = await resolveItemKeyViaLocalApiSearch(citeKey, hint, libraryPath);
            if (resolved) {
                itemKey = resolved.itemKey;
                route = resolved.route ?? route;
                libraryId = resolved.libraryId ?? libraryId;
                resolution = 'local-search';
            }
        } catch (err) {
            return {
                citekey: citeKey,
                itemKey: null,
                libraryId,
                route: null,
                selectUri: null,
                childrenCount: null,
                attachmentCount: 0,
                attachmentLabels: [],
                resolution,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    if (!itemKey) {
        return {
            citekey: citeKey,
            itemKey: null,
            libraryId,
            route: null,
            selectUri: null,
            childrenCount: null,
            attachmentCount: 0,
            attachmentLabels: [],
            resolution,
            error: `Unable to resolve Zotero item key for citekey ${citeKey}`,
        };
    }

    const routeLabel = route ? `${route.kind}/${route.ownerId}/items/${itemKey}` : null;
    const selectUri = zoteroSelectUri(libraryId ?? '1', itemKey);

    try {
        const children = await getChildrenViaLocalApiCandidates(null, libraryId, itemKey, route);
        const attachmentRows = children
            .filter((child): child is Record<string, unknown> => !!child && typeof child === 'object')
            .map((entry) => (entry.data ?? {}) as Record<string, unknown>)
            .filter((data) => data.itemType === 'attachment');
        const attachmentLabels = attachmentRows.map((data) => {
            const filename = typeof data.filename === 'string' ? data.filename.trim() : '';
            const title = typeof data.title === 'string' ? data.title.trim() : '';
            return filename || title || 'Attachment';
        });
        return {
            citekey: citeKey,
            itemKey,
            libraryId,
            route: routeLabel,
            selectUri,
            childrenCount: children.length,
            attachmentCount: attachmentRows.length,
            attachmentLabels,
            resolution,
        };
    } catch (err) {
        return {
            citekey: citeKey,
            itemKey,
            libraryId,
            route: routeLabel,
            selectUri,
            childrenCount: null,
            attachmentCount: 0,
            attachmentLabels: [],
            resolution,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

export async function localApiLibraryIndex(collectionPath: string): Promise<JsonObject[]> {
    return loadLocalApiLibraryIndex(collectionPath);
}

export async function pandocFilter(citekeys:string[], asCSL:boolean, libraryID:string, style: unknown, locale: unknown){

    const jsonRpcData = {
        jsonrpc: "2.0",
        method: "item.pandoc_filter",
        params: [citekeys, asCSL, libraryID, style]
    };

    const result = await makeJsonRpcHttpRequest(baseOptions, JSON.stringify(jsonRpcData));

    return result;

}


export async function exportCollectionPath(collectionPath:string, bibFormat = 'betterbibtex') {

    const coll: LocationResult = await locateCollection(collectionPath);
    if (!coll.collectionId) {
        return exportLibrary(coll.libraryId, coll.libraryName, bibFormat === 'betterbibtex' ? 'json' : bibFormat);
    }
    const exported_collection = await exportCollection(coll.collectionId, coll.libraryId, bibFormat);
    return exported_collection;

}

export function extractCitekey(item: JsonObject): string | null {
    const possible = [
        item.citationKey,
        item['citation-key'],
        item.citekey,
        item.id
    ];

    for (const value of possible) {
        if (typeof value === 'string' && value.trim().length > 0) {
            return value.trim();
        }
    }
    return null;
}

export function normalizeExportItems(items: unknown[]): JsonObject[] {
    return items
        .map((item) => (item ?? {}) as JsonObject)
        .map((item) => {
            const citekey = extractCitekey(item);
            const originalId = typeof item.id === 'string' ? item.id : '';
            const normalizedId = citekey ?? item.id ?? null;
            const itemKey = extractItemKey(item) ?? item.itemKey;
            return {
                ...item,
                itemKey,
                zoteroItemID: originalId && originalId !== normalizedId && originalId.startsWith('http') ? originalId : undefined,
                id: normalizedId,
            };
        });
}

export async function collectionCitekeys(collectionPath:string) {

    const resultJson = await exportCollectionPath(collectionPath, "json") as unknown[];
    return normalizeExportItems(resultJson)
        .map((item) => item.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);

}


export async function collectionCitekeysTitles(collectionPath:string) {

    const resultJson = await exportCollectionPath(collectionPath, "json") as unknown[];
    const result_keys_title = normalizeExportItems(resultJson)
        .map((item) => ({ id: item.id, title: item.title }))
        .filter((item) => typeof item.id === 'string')
        .map((item) => ({ id: item.id as string, title: typeof item.title === 'string' ? item.title : '' }));
    return result_keys_title;

}

export async function libraryCitekeysTitles(collectionPath:string, query:string, maxItems:number=200) {
    const searchQuery = query.trim();
    if (searchQuery.length < 2) {
        return [];
    }
    const cacheKey = `${collectionPath}::${searchQuery.toLowerCase()}::${maxItems}`;
    const cached = libraryQueryCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < LIBRARY_QUERY_CACHE_MS) {
        return cached.rows;
    }

    try {
        const coll: LocationResult = await locateCollection(collectionPath);
        const searchResults = await searchItems(searchQuery, coll.libraryId);
        const limited = searchResults.slice(0, maxItems);

        const refsByIndex = limited.map((item) => extractItemLookupRef(item, coll.libraryId));
        const refs = refsByIndex.filter((ref): ref is string => typeof ref === 'string');
        const keyMap = await getCitationkeyMapForItemRefs(refs);
        const suggestions = limited
            .map((item, idx) => {
                const ref = refsByIndex[idx];
                const id = ref ? keyMap[ref] : undefined;
                const itemKey = extractItemKey(item as JsonObject) ?? undefined;
                const itemUrl = typeof item.id === 'string' && item.id.startsWith('http') ? item.id : undefined;
                const title = typeof item.title === 'string' ? item.title : '';
                const author = Array.isArray(item.creators) ? item.creators[0] as JsonObject : null;
                const family = author && typeof author.lastName === 'string' ? author.lastName : '';
                const issued = item.issued as JsonObject | undefined;
                const dateParts = issued && Array.isArray(issued['date-parts']) ? issued['date-parts'] as unknown[] : [];
                const year = Array.isArray(dateParts) && Array.isArray(dateParts[0]) ? String((dateParts[0] as unknown[])[0] ?? '') : '';
                const meta = family && year ? `${family} (${year})` : (family || year || '');
                return { id, title, meta, itemKey, zoteroItemID: itemUrl };
            })
            .filter((entry) => typeof entry.id === 'string' && entry.id.length > 0)
            .map((entry) => ({
                id: entry.id as string,
                title: entry.title,
                meta: entry.meta,
                itemKey: entry.itemKey,
                zoteroItemID: entry.zoteroItemID,
            }));

        if (suggestions.length === 0) {
            const normalized = normalizeExportItems(limited);
            const fallback = normalized
                .map((item) => ({ id: item.id, title: typeof item.title === 'string' ? item.title : '' }))
                .filter((entry) => typeof entry.id === 'string')
                .map((entry) => ({ id: entry.id as string, title: entry.title }));
            libraryQueryCache.set(cacheKey, { ts: Date.now(), rows: fallback });
            return fallback;
        }

        libraryQueryCache.set(cacheKey, { ts: Date.now(), rows: suggestions });
        return suggestions;
    } catch (_err) {
        // fall through to local API Zotero 8 index path
    }

    const rows = await loadLocalApiLibraryIndex(collectionPath);
    const q = searchQuery.toLowerCase();
    const qCanonical = canonicalCitekey(searchQuery);
    const tokens = q.split(/\s+/).filter(Boolean);
    const scored: Array<{ row: JsonObject; score: number }> = [];

    for (const row of rows) {
        const id = typeof row.id === 'string' ? row.id : '';
        if (!id) continue;
        const title = typeof row.title === 'string' ? row.title : '';
        const creators = Array.isArray(row.creators) ? row.creators : [];
        const lead = creators.length > 0 && creators[0] && typeof creators[0] === 'object'
            ? (((creators[0] as Record<string, unknown>).lastName as string) || ((creators[0] as Record<string, unknown>).family as string) || '')
            : '';
        const year = typeof row.year === 'string'
            ? row.year
            : (() => {
                const issued = row.issued as Record<string, unknown> | undefined;
                const dateParts = issued && Array.isArray(issued['date-parts']) ? issued['date-parts'] as unknown[] : [];
                return Array.isArray(dateParts) && Array.isArray(dateParts[0]) ? String((dateParts[0] as unknown[])[0] ?? '') : '';
            })();

        const idLower = id.toLowerCase();
        const idCanonical = canonicalCitekey(id);
        const titleLower = title.toLowerCase();
        const metaLower = `${lead} ${year}`.toLowerCase();
        const hay = `${idLower} ${idCanonical} ${titleLower} ${metaLower}`;
        if (!tokens.every((t) => hay.includes(t))) continue;

        let score = 0;
        if (idLower.startsWith(q)) score += 120;
        else if (idLower.includes(q)) score += 90;
        if (qCanonical && idCanonical.startsWith(qCanonical)) score += 80;
        else if (qCanonical && idCanonical.includes(qCanonical)) score += 60;
        if (titleLower.includes(q)) score += 55;
        if (metaLower.includes(q)) score += 35;
        score -= idLower.indexOf(q) >= 0 ? idLower.indexOf(q) : 0;
        scored.push({ row, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const suggestions = scored.slice(0, maxItems).map(({ row }) => {
        const id = row.id as string;
        const title = typeof row.title === 'string' ? row.title : '';
        const creators = Array.isArray(row.creators) ? row.creators : [];
        const lead = creators.length > 0 && creators[0] && typeof creators[0] === 'object'
            ? (((creators[0] as Record<string, unknown>).lastName as string) || ((creators[0] as Record<string, unknown>).family as string) || '')
            : '';
        const year = typeof row.year === 'string'
            ? row.year
            : (() => {
                const issued = row.issued as Record<string, unknown> | undefined;
                const dateParts = issued && Array.isArray(issued['date-parts']) ? issued['date-parts'] as unknown[] : [];
                return Array.isArray(dateParts) && Array.isArray(dateParts[0]) ? String((dateParts[0] as unknown[])[0] ?? '') : '';
            })();
        const meta = lead && year ? `${lead} (${year})` : (lead || year || '');
        const itemKey = typeof row.itemKey === 'string' ? row.itemKey : undefined;
        const zoteroItemID = typeof row.zoteroItemID === 'string' ? row.zoteroItemID : undefined;
        return { id, title, meta, itemKey, zoteroItemID };
    });

    libraryQueryCache.set(cacheKey, { ts: Date.now(), rows: suggestions });
    return suggestions;
}
