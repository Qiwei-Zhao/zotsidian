import { requestUrl } from 'obsidian';

export type SemanticRelatedPaper = {
  paperId: string;
  title: string;
  year: number | null;
  venue: string;
  url: string;
  doi: string;
  authors: string[];
  citationCount: number | null;
  referenceCount: number | null;
  relation: 'reference' | 'citation';
};

export type RelatedPapersProvider = 'auto' | 'semantic-scholar' | 'openalex';

export type SemanticSourceRelatedData = {
	doi: string;
	paperId: string;
	title: string;
  url: string;
  year: number | null;
  venue: string;
	referenceCount: number;
	citationCount: number;
	references: SemanticRelatedPaper[];
	citations: SemanticRelatedPaper[];
	lookupMode: 'doi' | 'title';
	provider: 'semantic-scholar' | 'openalex';
};

export type SemanticSourceLookupInput = {
  doi?: string;
  title?: string;
  year?: number | null;
};

type SemanticAuthor = {
  name?: string;
};

type SemanticPaperRecord = {
  paperId?: string;
  title?: string;
  year?: number;
  venue?: string;
  url?: string;
  authors?: SemanticAuthor[];
  externalIds?: Record<string, string | undefined>;
  citationCount?: number;
  referenceCount?: number;
};

type SemanticPaperLookupResponse = SemanticPaperRecord & {
  citationCount?: number;
  referenceCount?: number;
};

type SemanticReferenceRow = {
  citedPaper?: SemanticPaperRecord;
};

type SemanticCitationRow = {
  citingPaper?: SemanticPaperRecord;
};

type SemanticPaginatedResponse<T> = {
  data?: T[];
  next?: number | string | null;
  total?: number;
};

type SemanticSearchResponse = {
  data?: SemanticPaperRecord[];
  total?: number;
  offset?: number;
  next?: number | string | null;
};

const SEMANTIC_API_BASE = 'https://api.semanticscholar.org/graph/v1';
const OPENALEX_API_BASE = 'https://api.openalex.org';
const SEMANTIC_PAGE_SIZE = 500;
const SEMANTIC_MAX_ROWS = 1000;
const semanticSourceCache = new Map<string, Promise<SemanticSourceRelatedData>>();

export function normalizeDoi(value: unknown): string {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (!raw) return '';
  const match = raw.match(/10\.[0-9]+\/\S+/i);
  return match?.[0]?.toLowerCase() || '';
}

function normalizeTitle(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function compactTitle(value: unknown): string {
  return normalizeTitle(value).replace(/\s+/g, '');
}

function semanticScholarPaperIdFromDoi(doi: string): string {
  return `DOI:${normalizeDoi(doi)}`;
}

async function getSemanticJson<T>(url: string): Promise<T> {
  const response = await requestUrl({
    url,
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  if (response.status < 200 || response.status >= 300) {
    throw Error(`Semantic Scholar request failed, status ${response.status}`);
  }

  return response.json as T;
}

async function getOpenAlexJson<T>(url: string): Promise<T> {
  const response = await requestUrl({
    url,
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  if (response.status < 200 || response.status >= 300) {
    throw Error(`OpenAlex request failed, status ${response.status}`);
  }

  return response.json as T;
}

function mapSemanticPaper(record: SemanticPaperRecord | undefined, relation: 'reference' | 'citation'): SemanticRelatedPaper | null {
  if (!record || typeof record !== 'object') return null;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  if (!title) return null;
  const doi = normalizeDoi(record.externalIds?.DOI);
  const authors = Array.isArray(record.authors)
    ? record.authors.map((author) => typeof author?.name === 'string' ? author.name.trim() : '').filter((name) => name.length > 0)
    : [];
  return {
    paperId: typeof record.paperId === 'string' ? record.paperId : '',
    title,
    year: typeof record.year === 'number' ? record.year : null,
    venue: typeof record.venue === 'string' ? record.venue.trim() : '',
    url: typeof record.url === 'string' ? record.url : '',
    doi,
    authors,
    citationCount: typeof record.citationCount === 'number' ? record.citationCount : null,
    referenceCount: typeof record.referenceCount === 'number' ? record.referenceCount : null,
    relation,
  };
}

function pickBestSearchResult(rows: SemanticPaperRecord[], title: string, year?: number | null): SemanticPaperRecord | null {
  const normalizedTitle = normalizeTitle(title);
  const compactQuery = compactTitle(title);
  if (!normalizedTitle) return rows[0] || null;

  const scored = rows
    .map((row) => {
      const rowTitle = typeof row.title === 'string' ? row.title : '';
      const normalizedRow = normalizeTitle(rowTitle);
      const compactRow = compactTitle(rowTitle);
      let score = 0;

      if (normalizedRow === normalizedTitle) score += 200;
      if (compactRow && compactRow === compactQuery) score += 160;
      if (normalizedRow && (normalizedRow.includes(normalizedTitle) || normalizedTitle.includes(normalizedRow))) score += 80;
      if (compactRow && compactQuery && (compactRow.includes(compactQuery) || compactQuery.includes(compactRow))) score += 60;

      if (typeof year === 'number' && Number.isFinite(year) && typeof row.year === 'number') {
        const diff = Math.abs(row.year - year);
        if (diff === 0) score += 40;
        else if (diff === 1) score += 25;
        else if (diff === 2) score += 10;
        else score -= Math.min(diff * 2, 20);
      }

      if (typeof row.citationCount === 'number') {
        score += Math.min(row.citationCount, 20);
      }

      return { row, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.row || null;
}

type OpenAlexAuthor = {
  author?: {
    display_name?: string;
  };
};

type OpenAlexLocation = {
  landing_page_url?: string;
  pdf_url?: string;
  source?: {
    display_name?: string;
  };
};

type OpenAlexWork = {
  id?: string;
  display_name?: string;
  publication_year?: number;
  authorships?: OpenAlexAuthor[];
  cited_by_count?: number;
  referenced_works_count?: number;
  referenced_works?: string[];
  doi?: string;
  ids?: Record<string, string | undefined>;
  primary_location?: OpenAlexLocation | null;
  locations?: OpenAlexLocation[];
};

type OpenAlexListResponse = {
  results?: OpenAlexWork[];
  meta?: {
    count?: number;
    next_cursor?: string | null;
  };
};

function openAlexShortId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const matched = trimmed.match(/(?:^|\/)(W\d+)$/i);
  if (matched?.[1]) return matched[1].toUpperCase();
  return /^W\d+$/i.test(trimmed) ? trimmed.toUpperCase() : '';
}

function openAlexUrlForWork(work: OpenAlexWork): string {
  const primaryLanding = work.primary_location?.landing_page_url;
  if (typeof primaryLanding === 'string' && primaryLanding.trim()) return primaryLanding.trim();
  const doi = normalizeDoi(work.doi || work.ids?.doi);
  if (doi) return `https://doi.org/${doi}`;
  const shortId = openAlexShortId(work.id);
  return shortId ? `https://openalex.org/${shortId}` : '';
}

function mapOpenAlexWork(work: OpenAlexWork | undefined, relation: 'reference' | 'citation'): SemanticRelatedPaper | null {
  if (!work || typeof work !== 'object') return null;
  const title = typeof work.display_name === 'string' ? work.display_name.trim() : '';
  if (!title) return null;
  const authors = Array.isArray(work.authorships)
    ? work.authorships
        .map((row) => typeof row?.author?.display_name === 'string' ? row.author.display_name.trim() : '')
        .filter((name) => name.length > 0)
    : [];
  const venue = typeof work.primary_location?.source?.display_name === 'string'
    ? work.primary_location.source.display_name.trim()
    : '';
  const doi = normalizeDoi(work.doi || work.ids?.doi);
  const paperId = openAlexShortId(work.id);
  return {
    paperId,
    title,
    year: typeof work.publication_year === 'number' ? work.publication_year : null,
    venue,
    url: openAlexUrlForWork(work),
    doi,
    authors,
    citationCount: typeof work.cited_by_count === 'number' ? work.cited_by_count : null,
    referenceCount: typeof work.referenced_works_count === 'number' ? work.referenced_works_count : null,
    relation,
  };
}

function pickBestOpenAlexResult(rows: OpenAlexWork[], title: string, year?: number | null): OpenAlexWork | null {
  const normalizedTitle = normalizeTitle(title);
  const compactQuery = compactTitle(title);
  if (!normalizedTitle) return rows[0] || null;

  const scored = rows
    .map((row) => {
      const rowTitle = typeof row.display_name === 'string' ? row.display_name : '';
      const normalizedRow = normalizeTitle(rowTitle);
      const compactRow = compactTitle(rowTitle);
      let score = 0;

      if (normalizedRow === normalizedTitle) score += 200;
      if (compactRow && compactRow === compactQuery) score += 160;
      if (normalizedRow && (normalizedRow.includes(normalizedTitle) || normalizedTitle.includes(normalizedRow))) score += 80;
      if (compactRow && compactQuery && (compactRow.includes(compactQuery) || compactQuery.includes(compactRow))) score += 60;

      if (typeof year === 'number' && Number.isFinite(year) && typeof row.publication_year === 'number') {
        const diff = Math.abs(row.publication_year - year);
        if (diff === 0) score += 40;
        else if (diff === 1) score += 25;
        else if (diff === 2) score += 10;
        else score -= Math.min(diff * 2, 20);
      }

      if (typeof row.cited_by_count === 'number') {
        score += Math.min(row.cited_by_count, 20);
      }

      return { row, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.row || null;
}

async function findSemanticPaper(input: SemanticSourceLookupInput): Promise<{ paper: SemanticPaperLookupResponse; lookupMode: 'doi' | 'title' }> {
  const doi = normalizeDoi(input.doi);
  if (doi) {
    const paperId = semanticScholarPaperIdFromDoi(doi);
    const paperUrl = `${SEMANTIC_API_BASE}/paper/${encodeURIComponent(paperId)}?fields=${encodeURIComponent('paperId,title,url,year,venue,citationCount,referenceCount,externalIds')}`;
    const paper = await getSemanticJson<SemanticPaperLookupResponse>(paperUrl);
    return { paper, lookupMode: 'doi' };
  }

  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) {
    throw Error('Semantic Scholar lookup requires a DOI or title.');
  }

  const searchUrl = `${SEMANTIC_API_BASE}/paper/search?query=${encodeURIComponent(title)}&fields=${encodeURIComponent('paperId,title,url,year,venue,citationCount,referenceCount,externalIds,authors')}&limit=10`;
  const payload = await getSemanticJson<SemanticSearchResponse>(searchUrl);
  const rows = Array.isArray(payload.data) ? payload.data : [];
  const best = pickBestSearchResult(rows, title, input.year);

  if (!best) {
    throw Error(`Semantic Scholar search returned no paper match for "${title}".`);
  }

  return {
    paper: best,
    lookupMode: 'title',
  };
}

async function findOpenAlexPaper(input: SemanticSourceLookupInput): Promise<{ paper: OpenAlexWork; lookupMode: 'doi' | 'title' }> {
  const doi = normalizeDoi(input.doi);
  if (doi) {
    const url = `${OPENALEX_API_BASE}/works/${encodeURIComponent(`https://doi.org/${doi}`)}`;
    const paper = await getOpenAlexJson<OpenAlexWork>(url);
    return { paper, lookupMode: 'doi' };
  }

  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) {
    throw Error('OpenAlex lookup requires a DOI or title.');
  }

  const url = `${OPENALEX_API_BASE}/works?search=${encodeURIComponent(title)}&per-page=10`;
  const payload = await getOpenAlexJson<OpenAlexListResponse>(url);
  const rows = Array.isArray(payload.results) ? payload.results : [];
  const best = pickBestOpenAlexResult(rows, title, input.year);
  if (!best) {
    throw Error(`OpenAlex search returned no paper match for "${title}".`);
  }
  return { paper: best, lookupMode: 'title' };
}

async function fetchSemanticRows(
  paperId: string,
  relation: 'reference' | 'citation'
): Promise<SemanticRelatedPaper[]> {
  const results: SemanticRelatedPaper[] = [];
  let offset = 0;
  const fields = relation === 'reference'
    ? 'citedPaper.paperId,citedPaper.title,citedPaper.year,citedPaper.venue,citedPaper.url,citedPaper.authors,citedPaper.externalIds,citedPaper.citationCount,citedPaper.referenceCount'
    : 'citingPaper.paperId,citingPaper.title,citingPaper.year,citingPaper.venue,citingPaper.url,citingPaper.authors,citingPaper.externalIds,citingPaper.citationCount,citingPaper.referenceCount';

  while (offset < SEMANTIC_MAX_ROWS) {
    const url = `${SEMANTIC_API_BASE}/paper/${encodeURIComponent(paperId)}/${relation === 'reference' ? 'references' : 'citations'}?fields=${encodeURIComponent(fields)}&limit=${SEMANTIC_PAGE_SIZE}&offset=${offset}`;
    const payload = await getSemanticJson<SemanticPaginatedResponse<SemanticReferenceRow | SemanticCitationRow>>(url);
    const rows = Array.isArray(payload.data) ? payload.data : [];
    if (rows.length === 0) break;

    for (const row of rows) {
      const record = relation === 'reference'
        ? (row as SemanticReferenceRow).citedPaper
        : (row as SemanticCitationRow).citingPaper;
      const mapped = mapSemanticPaper(record, relation);
      if (mapped) results.push(mapped);
    }

    if (rows.length < SEMANTIC_PAGE_SIZE) break;
    offset += rows.length;
  }

  return results;
}

async function fetchOpenAlexRowsByIds(ids: string[], relation: 'reference' | 'citation'): Promise<SemanticRelatedPaper[]> {
  const uniqueIds = Array.from(new Set(ids.map((id) => openAlexShortId(id)).filter((id) => id.length > 0)));
  if (uniqueIds.length === 0) return [];
  const results: SemanticRelatedPaper[] = [];
  const chunkSize = 50;
  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    const url = `${OPENALEX_API_BASE}/works?filter=openalex:${encodeURIComponent(chunk.join('|'))}&per-page=${chunk.length}`;
    const payload = await getOpenAlexJson<OpenAlexListResponse>(url);
    const rows = Array.isArray(payload.results) ? payload.results : [];
    for (const row of rows) {
      const mapped = mapOpenAlexWork(row, relation);
      if (mapped) results.push(mapped);
    }
  }
  return results;
}

async function fetchOpenAlexCitations(workId: string): Promise<SemanticRelatedPaper[]> {
  const shortId = openAlexShortId(workId);
  if (!shortId) return [];
  const results: SemanticRelatedPaper[] = [];
  const pageSize = 100;
  let page = 1;

  while (results.length < SEMANTIC_MAX_ROWS) {
    const url = `${OPENALEX_API_BASE}/works?filter=cites:${encodeURIComponent(shortId)}&per-page=${pageSize}&page=${page}`;
    const payload = await getOpenAlexJson<OpenAlexListResponse>(url);
    const rows = Array.isArray(payload.results) ? payload.results : [];
    if (rows.length === 0) break;
    for (const row of rows) {
      const mapped = mapOpenAlexWork(row, 'citation');
      if (mapped) results.push(mapped);
    }
    if (rows.length < pageSize) break;
    page += 1;
  }

  return results;
}

async function fetchSourceRelatedPapersViaOpenAlex(input: SemanticSourceLookupInput): Promise<SemanticSourceRelatedData> {
  const { paper, lookupMode } = await findOpenAlexPaper(input);
  const workId = openAlexShortId(paper.id);
  if (!workId) {
    throw Error('OpenAlex paper lookup did not return a work id.');
  }

  const referencedWorks = Array.isArray(paper.referenced_works) ? paper.referenced_works : [];
  const [references, citations] = await Promise.all([
    fetchOpenAlexRowsByIds(referencedWorks.slice(0, SEMANTIC_MAX_ROWS), 'reference'),
    fetchOpenAlexCitations(workId),
  ]);

  const doi = normalizeDoi(paper.doi || paper.ids?.doi || input.doi);
  return {
    doi,
    paperId: workId,
    title: typeof paper.display_name === 'string' && paper.display_name.trim().length > 0
      ? paper.display_name.trim()
      : (typeof input.title === 'string' ? input.title.trim() : doi),
    url: openAlexUrlForWork(paper),
    year: typeof paper.publication_year === 'number' ? paper.publication_year : null,
    venue: typeof paper.primary_location?.source?.display_name === 'string' ? paper.primary_location.source.display_name.trim() : '',
    referenceCount: typeof paper.referenced_works_count === 'number' ? paper.referenced_works_count : references.length,
    citationCount: typeof paper.cited_by_count === 'number' ? paper.cited_by_count : citations.length,
    references,
    citations,
    lookupMode,
    provider: 'openalex',
  };
}

async function fetchSourceRelatedPapersViaSemanticScholar(input: SemanticSourceLookupInput, normalizedDoi: string): Promise<SemanticSourceRelatedData> {
  const { paper, lookupMode } = await findSemanticPaper(input);
  const paperId = typeof paper.paperId === 'string' && paper.paperId.trim().length > 0
    ? paper.paperId
    : (normalizedDoi ? semanticScholarPaperIdFromDoi(normalizedDoi) : '');
  if (!paperId) {
    throw Error('Semantic Scholar paper lookup did not return a paperId.');
  }

  const [references, citations] = await Promise.all([
    fetchSemanticRows(paperId, 'reference'),
    fetchSemanticRows(paperId, 'citation'),
  ]);

  return {
    doi: normalizeDoi(paper.externalIds?.DOI) || normalizedDoi,
    paperId: typeof paper.paperId === 'string' ? paper.paperId : '',
    title: typeof paper.title === 'string' ? paper.title : normalizedDoi,
    url: typeof paper.url === 'string' ? paper.url : '',
    year: typeof paper.year === 'number' ? paper.year : null,
    venue: typeof paper.venue === 'string' ? paper.venue : '',
    referenceCount: typeof paper.referenceCount === 'number' ? paper.referenceCount : references.length,
    citationCount: typeof paper.citationCount === 'number' ? paper.citationCount : citations.length,
    references,
    citations,
    lookupMode,
    provider: 'semantic-scholar',
  };
}

function semanticResultLooksUsable(result: SemanticSourceRelatedData): boolean {
  const hasAnySignal = result.referenceCount > 0
    || result.citationCount > 0
    || result.references.length > 0
    || result.citations.length > 0;

  if (!hasAnySignal) {
    return false;
  }

  const brokenReferences = result.referenceCount > 0 && result.references.length === 0;
  const brokenCitations = result.citationCount > 0 && result.citations.length === 0;

  return !(brokenReferences || brokenCitations);
}

export async function fetchSourceRelatedPapers(input: string | SemanticSourceLookupInput, provider: RelatedPapersProvider = 'auto'): Promise<SemanticSourceRelatedData> {
  const lookupInput: SemanticSourceLookupInput = typeof input === 'string' ? { doi: input } : input;
  const normalized = normalizeDoi(lookupInput.doi);
  const title = typeof lookupInput.title === 'string' ? lookupInput.title.trim() : '';
  const year = typeof lookupInput.year === 'number' && Number.isFinite(lookupInput.year) ? lookupInput.year : null;
  const cacheKey = normalized
    ? `${provider}:doi:${normalized}`
    : `${provider}:title:${normalizeTitle(title)}:${year == null ? '' : String(year)}`;
  if (!normalized && !title) {
    throw Error('Semantic Scholar lookup requires a DOI or title.');
  }

  const cached = semanticSourceCache.get(cacheKey);
  if (cached) {
    return await cached;
  }

  const pending = (async () => {
    if (provider === 'semantic-scholar') {
      return await fetchSourceRelatedPapersViaSemanticScholar(lookupInput, normalized);
    }
    if (provider === 'openalex') {
      return await fetchSourceRelatedPapersViaOpenAlex(lookupInput);
    }

    try {
      const semantic = await fetchSourceRelatedPapersViaSemanticScholar(lookupInput, normalized);
      if (semanticResultLooksUsable(semantic)) {
        return semantic;
      }
    } catch (_err) {
      // fall through to OpenAlex
    }

    return await fetchSourceRelatedPapersViaOpenAlex(lookupInput);
  })();

  semanticSourceCache.set(cacheKey, pending);

  try {
    return await pending;
  } catch (error) {
    semanticSourceCache.delete(cacheKey);
    throw error;
  }
}
