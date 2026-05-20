import type { TFile } from 'obsidian';
import { attachments } from 'ZoteroFunctions';
import {
  getSourceManagedAnnotationItemMarkers,
  getSourceManagedBlockHeading,
  getSourceManagedBlockMarkers,
  getLegacySourceManagedAnnotationItemMarkers,
  getLegacySourceManagedBlockMarkers,
  type SourceManagedBlockSection,
} from 'SourceNoteMarkers';
import {
  renderAnnotationInsertPayloadWithOptionalTemplate,
  type AnnotationTemplateInput,
} from 'AnnotationTemplate';
import type { TemplateBackend } from 'TemplateBackend';
import type { SourceRelatedData } from 'main';

export type SourceManagedAnnotation = {
  key: string;
  parentItem: string;
  annotationType?: string;
  annotationColor?: string;
  annotationComment?: string;
  annotationTags?: string[];
  annotationPageLabel?: string;
  annotationPosition?: unknown;
  annotationSortIndex?: string;
  annotationText?: string;
  annotationImagePath?: string;
  dateAdded?: string;
  dateModified?: string;
  openHref?: string;
};

export type SourceManagedAttachmentRow = {
  label: string;
  open: string;
  annotations: SourceManagedAnnotation[];
};

export type SourceNoteSyncPayload = {
  annotations: SourceManagedAttachmentRow[];
  related: SourceRelatedData | null;
};

export type SourceNoteSyncRenderers = {
  annotationTextTemplate: string;
  annotationImageTemplate: string;
  annotationBackend?: TemplateBackend;
};

export function hasManagedBlock(content: string, section: SourceManagedBlockSection): boolean {
  return findManagedBlockRange(content, section) !== null;
}

export function hasAnyManagedBlock(content: string, sections: SourceManagedBlockSection[]): boolean {
  return sections.some((section) => hasManagedBlock(content, section));
}

export function replaceManagedBlock(content: string, section: SourceManagedBlockSection, replacement: string): string {
  const range = findManagedBlockRange(content, section);
  if (!range) return content;
  const suffix = content.slice(range.end);
  const block = suffix.length > 0
    ? `${wrapManagedBlockWithContent(section, replacement)}\n\n`
    : wrapManagedBlockWithContent(section, replacement);
  return `${content.slice(0, range.start)}${block}${suffix}`;
}

export function renderManagedAnnotationsMarkdown(
  rows: SourceManagedAttachmentRow[],
  currentSectionContent: string,
  renderers: SourceNoteSyncRenderers
): string {
  const seen = new Set<string>();
  const groups = rows
    .map((row) => ({
      ...row,
      annotations: sortManagedAnnotationsByPdfOrder(
        (Array.isArray(row.annotations) ? row.annotations : []).filter((annotation) => {
          const key = (annotation.key || '').trim();
          if (!key) return false;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
      ),
    }))
    .filter((row) => row.annotations.length > 0);
  if (groups.length === 0) {
    return '## Annotations\n\n_No annotations found._';
  }
  const importsByKey = new Map<string, string>();
  for (const row of groups) {
    for (const annotation of row.annotations) {
      const key = normalizeAnnotationKey(annotation.key);
      if (!key) continue;
      importsByKey.set(key, renderManagedAnnotationImport(annotation, renderers));
    }
  }
  const annotationsByKey = new Map<string, SourceManagedAnnotation>();
  for (const row of groups) {
    for (const annotation of row.annotations) {
      const key = normalizeAnnotationKey(annotation.key);
      if (key) annotationsByKey.set(key, annotation);
    }
  }
  const preservedNotesByKey = extractPreservedAnnotationNotes(currentSectionContent, importsByKey, annotationsByKey);
  const parts: string[] = ['## Annotations'];
  for (const row of groups) {
    parts.push(`### ${row.label}`);
    for (const annotation of row.annotations) {
      const key = normalizeAnnotationKey(annotation.key);
      const imported = importsByKey.get(key) || renderManagedAnnotationImport(annotation, renderers);
      const notes = preservedNotesByKey.get(key) || '';
      parts.push(renderStructuredManagedAnnotationItem(annotation, imported, notes));
      parts.push('');
    }
  }
  return parts.join('\n').trim();
}

function sortManagedAnnotationsByPdfOrder(annotations: SourceManagedAnnotation[]): SourceManagedAnnotation[] {
  return [...annotations].sort(compareManagedAnnotationsByPdfOrder);
}

function compareManagedAnnotationsByPdfOrder(a: SourceManagedAnnotation, b: SourceManagedAnnotation): number {
  const pageA = parseAnnotationPage(a.annotationPageLabel);
  const pageB = parseAnnotationPage(b.annotationPageLabel);
  if (pageA !== pageB) return pageA - pageB;

  const sortA = (a.annotationSortIndex || '').trim();
  const sortB = (b.annotationSortIndex || '').trim();
  if (sortA && sortB && sortA !== sortB) return sortA.localeCompare(sortB, undefined, { numeric: true });
  if (sortA && !sortB) return -1;
  if (!sortA && sortB) return 1;

  const posA = stringifyAnnotationPosition(a.annotationPosition);
  const posB = stringifyAnnotationPosition(b.annotationPosition);
  if (posA && posB && posA !== posB) return posA.localeCompare(posB, undefined, { numeric: true });

  const dateA = Date.parse(a.dateAdded || a.dateModified || '') || 0;
  const dateB = Date.parse(b.dateAdded || b.dateModified || '') || 0;
  return dateA - dateB;
}

function parseAnnotationPage(value: string | undefined): number {
  const matched = (value || '').match(/\d+/);
  return matched ? Number(matched[0]) : Number.MAX_SAFE_INTEGER;
}

function stringifyAnnotationPosition(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return '';
  }
}

export function renderManagedRelatedMarkdown(related: SourceRelatedData | null): string {
  const references = related?.references || [];
  const citations = related?.citations || [];
  const library = related?.relatedLibraryItems || [];
  const parts: string[] = ['## Related'];

  parts.push(`- References: ${references.length}`);
  parts.push(`- Citations: ${citations.length}`);
  parts.push(`- Related library items: ${library.length}`);
  parts.push('');

  if (library.length > 0) {
    parts.push('### Related library items');
    for (const item of library) {
      parts.push(`- [[@${item.citekey}]]`);
    }
  } else if (references.length === 0 && citations.length === 0) {
    parts.push('_No related papers found._');
  }

  return parts.join('\n').trim();
}

export function renderManagedReferencesMarkdown(related: SourceRelatedData | null): string {
  const references = related?.references || [];
  const parts: string[] = ['## References'];
  if (references.length === 0) {
    parts.push('');
    parts.push('_No references found._');
    return parts.join('\n').trim();
  }
  for (const reference of references) {
    if (reference.localMatch?.citekey) {
      parts.push(`- [[@${reference.localMatch.citekey}]]`);
      continue;
    }
    const title = (reference.title || '').trim() || 'Untitled';
    const year = reference.year == null ? '' : ` (${reference.year})`;
    parts.push(`- ${title}${year}`);
  }
  return parts.join('\n').trim();
}

export function renderManagedCitationsMarkdown(related: SourceRelatedData | null): string {
  const citations = related?.citations || [];
  const parts: string[] = ['## Citations'];
  if (citations.length === 0) {
    parts.push('');
    parts.push('_No citations found._');
    return parts.join('\n').trim();
  }
  for (const citation of citations) {
    if (citation.localMatch?.citekey) {
      parts.push(`- [[@${citation.localMatch.citekey}]]`);
      continue;
    }
    const title = (citation.title || '').trim() || 'Untitled';
    const year = citation.year == null ? '' : ` (${citation.year})`;
    parts.push(`- ${title}${year}`);
  }
  return parts.join('\n').trim();
}

export async function syncSourceNoteManagedBlocks(
  file: TFile,
  payload: SourceNoteSyncPayload,
  renderers: SourceNoteSyncRenderers,
  io: {
    read: (file: TFile) => Promise<string>;
    modify: (file: TFile, content: string) => Promise<void>;
  },
  currentContent?: string,
  options: { createMissingAnnotationsBlock?: boolean } = {}
): Promise<boolean> {
  const current = typeof currentContent === 'string' ? currentContent : await io.read(file);
  const buildNext = (content: string): string => {
    let next = content;
    if (!hasManagedBlock(next, 'annotations') && options.createMissingAnnotationsBlock) {
      next = `${next.trimEnd()}\n\n${getSourceManagedBlockHeading('annotations')}\n`;
    }
    if (hasManagedBlock(next, 'annotations')) {
      const existingAnnotationsSection = extractManagedBlockContent(next, 'annotations');
      next = replaceManagedBlock(
        next,
        'annotations',
        renderManagedAnnotationsMarkdown(payload.annotations, existingAnnotationsSection, renderers)
      );
    }
    return next;
  };
  const next = buildNext(current);
  if (next === current) return false;

  const latest = await io.read(file);
  if (latest !== current) {
    const latestNext = buildNext(latest);
    if (latestNext === latest) return false;
    await io.modify(file, latestNext);
    return true;
  }

  await io.modify(file, next);
  return true;
}

export type SourceManagedAttachmentLoadResult = {
  rows: SourceManagedAttachmentRow[];
  error?: string;
};

export async function loadSourceManagedAttachmentRows(
  citekey: string,
  scope: string,
  hint: Record<string, unknown>,
): Promise<SourceManagedAttachmentLoadResult> {
  try {
    const rows = await attachments(citekey, scope.split('/')[0] || scope, hint as any);
    const normalized = Array.isArray(rows) ? rows : [];
    return {
      rows: normalized
        .filter((row) => !!row && typeof row === 'object' && typeof (row as any).open === 'string')
        .map((row: any) => ({
          label: typeof row.label === 'string' && row.label.trim().length > 0 ? row.label.trim() : 'Attachment',
          open: row.open,
              annotations: Array.isArray(row.annotations)
                ? row.annotations.map((annotation: any) => ({
                  key: typeof annotation?.key === 'string' ? annotation.key : '',
                  parentItem: citekey,
                  annotationType: typeof annotation?.annotationType === 'string' ? annotation.annotationType : '',
                  annotationColor: typeof annotation?.annotationColor === 'string' ? annotation.annotationColor : '',
                  annotationComment: typeof annotation?.annotationComment === 'string' ? annotation.annotationComment : '',
                  annotationTags: Array.isArray(annotation?.annotationTags)
                    ? annotation.annotationTags.filter((tag: unknown): tag is string => typeof tag === 'string' && tag.trim().length > 0)
                    : [],
                  annotationPageLabel: typeof annotation?.annotationPageLabel === 'string' ? annotation.annotationPageLabel : '',
                  annotationPosition: annotation?.annotationPosition,
                  annotationSortIndex: typeof annotation?.annotationSortIndex === 'string' ? annotation.annotationSortIndex : '',
                  annotationText: typeof annotation?.annotationText === 'string' ? annotation.annotationText : '',
                  annotationImagePath: typeof annotation?.annotationImagePath === 'string' ? annotation.annotationImagePath : '',
                  dateAdded: typeof annotation?.dateAdded === 'string' ? annotation.dateAdded : '',
                  dateModified: typeof annotation?.dateModified === 'string' ? annotation.dateModified : '',
                  openHref: typeof annotation?.openHref === 'string' ? annotation.openHref : row.open,
              }))
            : [],
        })),
    };
  } catch (err) {
    return {
      rows: [],
      error: err instanceof Error ? err.message : String(err || 'Unknown Zotero attachment lookup error'),
    };
  }
}

export function normalizeAttachmentHint(raw: Record<string, unknown>, citekey: string, zoteroDataDir: string): Record<string, unknown> {
  const itemKey = parseItemKey(raw);
  return {
    itemKey,
    zoteroItemID: typeof raw['zoteroItemID'] === 'string' ? raw['zoteroItemID'] : undefined,
    zotero: typeof raw['zotero'] === 'string' ? raw['zotero'] : undefined,
    citekey: typeof raw['id'] === 'string' ? raw['id'] : citekey,
    doi: typeof raw['DOI'] === 'string' ? raw['DOI'] : undefined,
    title: typeof raw['title'] === 'string' ? raw['title'] : undefined,
    zoteroDataDir: zoteroDataDir || undefined,
  };
}

function wrapManagedBlockWithContent(section: SourceManagedBlockSection, content: string): string {
  const normalized = (content || '').trim();
  return normalized || getSourceManagedBlockHeading(section);
}

function extractManagedBlockContent(content: string, section: SourceManagedBlockSection): string {
  const range = findManagedBlockRange(content, section);
  if (!range) return '';
  return content.slice(range.innerStart, range.innerEnd).trim();
}

function extractPreservedAnnotationNotes(
  sectionContent: string,
  importsByKey: Map<string, string>,
  annotationsByKey: Map<string, SourceManagedAnnotation> = new Map()
): Map<string, string> {
  const result = new Map<string, string>();
  const visibleNotes = parseVisibleAnnotationItems(sectionContent, importsByKey, annotationsByKey);
  for (const [key, notes] of visibleNotes) {
    if (importsByKey.has(key)) result.set(key, notes);
  }
  const legacyCalloutNotes = parseLegacyCalloutAnnotationNotes(sectionContent);
  for (const [key, imported] of importsByKey) {
    if (result.has(key)) continue;
    const visibleOrMarkerNotes = getPreservedAnnotationTail(sectionContent, key, imported, annotationsByKey.get(key));
    const legacyNotes = legacyCalloutNotes.get(key) || '';
    const notes = visibleOrMarkerNotes || legacyNotes;
    if (notes) result.set(key, notes);
  }
  return result;
}

function getPreservedAnnotationTail(
  sectionContent: string,
  key: string,
  importedContent = '',
  annotation?: SourceManagedAnnotation
): string {
  const normalizedKey = normalizeAnnotationKey(key);
  if (!normalizedKey) return '';
  const pattern = /(?:%% zotsidian:item-begin section=annotations key=([^\s]+) %%|<!-- zotsidian:item-begin section=annotations key=([^\s]+) -->)([\s\S]*?)(?:%% zotsidian:item-end %%|<!-- zotsidian:item-end -->)/gm;
  let matched: RegExpExecArray | null = null;
  while ((matched = pattern.exec(sectionContent)) !== null) {
    const currentKey = normalizeAnnotationKey(matched[1] || matched[2] || '');
    const body = matched[3] || '';
    if (!currentKey || currentKey !== normalizedKey) continue;
    const itemMarkers = getSourceManagedAnnotationItemMarkers(currentKey);
    const legacyItemMarkers = getLegacySourceManagedAnnotationItemMarkers(currentKey);
    const notesPattern = new RegExp([
      `(?:${escapeRegExp(itemMarkers.notesBegin)}|${escapeRegExp(legacyItemMarkers.notesBegin)})`,
      `\\n?([\\s\\S]*?)\\n?`,
      `(?:${escapeRegExp(itemMarkers.notesEnd)}|${escapeRegExp(legacyItemMarkers.notesEnd)})`,
    ].join(''), 'm');
    const notesMatch = body.match(notesPattern);
    if (notesMatch) {
      const markerNotes = sanitizePreservedAnnotationNotes(notesMatch[1] || '');
      if (markerNotes) return markerNotes;
      const postItemNotes = parseLegacyPostItemNotes(sectionContent);
      if (postItemNotes.has(normalizedKey)) return postItemNotes.get(normalizedKey) || '';
      return '';
    }
    const importPattern = new RegExp([
      `(?:${escapeRegExp(itemMarkers.importBegin)}|${escapeRegExp(legacyItemMarkers.importBegin)})`,
      `\\n?[\\s\\S]*?\\n?`,
      `(?:${escapeRegExp(itemMarkers.importEnd)}|${escapeRegExp(legacyItemMarkers.importEnd)})`,
    ].join(''), 'm');
    return sanitizePreservedAnnotationNotes(stripGeneratedAnnotationContent(body.replace(importPattern, ''), importedContent, annotation));
  }
  const legacyCallout = parseLegacyCalloutAnnotationNotes(sectionContent);
  if (legacyCallout.has(normalizedKey)) return legacyCallout.get(normalizedKey) || '';
  const structured = parseStructuredAnnotationItems(sectionContent);
  return structured.get(normalizedKey) || '';
}

function sanitizePreservedAnnotationNotes(content: string): string {
  const lines = (content || '').split('\n');
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (/^(?:%%|<!--)\s*zotsidian:/i.test(trimmed)) return false;
    if (/^zotsidian:/i.test(trimmed)) return false;
    return true;
  });
  return filtered.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeMarkdownForPrefix(value: string): string {
  return (value || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

function removeGeneratedPrefix(block: string, importedContent: string, annotation?: SourceManagedAnnotation): string {
  let remaining = (block || '').trim();
  const imported = normalizeMarkdownForPrefix(importedContent);
  const importedAsQuote = normalizeMarkdownForPrefix(toManagedImportedBlock(importedContent));
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of [imported, importedAsQuote]) {
      if (!candidate) continue;
      const normalizedRemaining = normalizeMarkdownForPrefix(remaining);
      if (normalizedRemaining.startsWith(candidate)) {
        remaining = normalizedRemaining.slice(candidate.length);
        changed = true;
        break;
      }
    }
    const stripped = stripGeneratedAnnotationContent(remaining, importedContent, annotation);
    if (stripped !== remaining.trim()) {
      remaining = stripped;
      changed = true;
    }
  }

  const lines = remaining.split('\n');
  let index = 0;
  while (index < lines.length && lines[index].trim() === '') index += 1;
  if (index < lines.length && lines[index].trim().startsWith('>')) {
    while (index < lines.length && (lines[index].trim() === '' || lines[index].trim().startsWith('>'))) {
      index += 1;
    }
    remaining = lines.slice(index).join('\n');
  }
  return sanitizePreservedAnnotationNotes(stripGeneratedAnnotationContent(remaining, importedContent, annotation));
}

function parseVisibleAnnotationItems(
  sectionContent: string,
  importsByKey: Map<string, string>,
  annotationsByKey: Map<string, SourceManagedAnnotation>
): Map<string, string> {
  const result = new Map<string, string>();
  const lines = (sectionContent || '').split('\n');
  const anchorPattern = /^(?:\[Open in Zotero · ([A-Z0-9]+)\]\(([^)]+)\)|Open in Zotero · ([A-Z0-9]+))$/i;
  for (let index = 0; index < lines.length; index += 1) {
    const matched = lines[index].trim().match(anchorPattern);
    if (!matched) continue;
    const key = normalizeAnnotationKey(matched[1] || matched[3] || '');
    if (!key) continue;
    let end = index + 1;
    while (end < lines.length) {
      const candidate = lines[end].trim();
      if (anchorPattern.test(candidate)) break;
      if (/^###\s+/.test(candidate) || /^##\s+/.test(candidate)) break;
      end += 1;
    }
    const importedContent = importsByKey.get(key) || '';
    const annotation = annotationsByKey.get(key);
    const notes = removeGeneratedPrefix(lines.slice(index + 1, end).join('\n'), importedContent, annotation);
    mergePreservedAnnotationNotes(result, key, notes);
    index = Math.max(index, end - 1);
  }
  return result;
}

function mergePreservedAnnotationNotes(target: Map<string, string>, key: string, notes: string): void {
  const normalizedKey = normalizeAnnotationKey(key);
  const normalizedNotes = sanitizePreservedAnnotationNotes(notes);
  if (!normalizedKey) return;
  if (!normalizedNotes) {
    if (!target.has(normalizedKey)) target.set(normalizedKey, '');
    return;
  }
  const existing = target.get(normalizedKey) || '';
  if (!existing) {
    target.set(normalizedKey, normalizedNotes);
    return;
  }
  target.set(normalizedKey, appendUniquePreservedNotes(existing, normalizedNotes));
}

function appendUniquePreservedNotes(existing: string, incoming: string): string {
  const chunks = [existing, incoming]
    .map((chunk) => sanitizePreservedAnnotationNotes(chunk))
    .filter((chunk) => chunk.length > 0);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const chunk of chunks) {
    const comparable = normalizeGeneratedAnnotationText(chunk);
    if (comparable && seen.has(comparable)) continue;
    if (comparable) seen.add(comparable);
    kept.push(chunk);
  }
  return kept.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripGeneratedAnnotationContent(
  content: string,
  importedContent = '',
  annotation?: SourceManagedAnnotation
): string {
  return sanitizePreservedAnnotationNotes(
    dedupePreservedManualLines(
      removeGeneratedAnnotationLines(content, importedContent, annotation)
    )
  );
}

function removeGeneratedAnnotationLines(
  content: string,
  importedContent = '',
  annotation?: SourceManagedAnnotation
): string {
  const generated = collectGeneratedAnnotationComparables(importedContent, annotation);
  const imageBasename = getPathBasename(annotation?.annotationImagePath || '');
  const lines = (content || '').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (kept.length > 0 && kept[kept.length - 1].trim() !== '') kept.push(line);
      continue;
    }
    if (isGeneratedAnnotationLine(trimmed, generated, annotation, imageBasename)) continue;
    kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function collectGeneratedAnnotationComparables(
  importedContent = '',
  annotation?: SourceManagedAnnotation
): string[] {
  const candidates = [
    importedContent,
    toManagedImportedBlock(importedContent),
    annotation?.annotationText || '',
    annotation?.annotationComment || '',
    annotation?.annotationImagePath ? buildLocalImageEmbed(annotation.annotationImagePath) : '',
  ];
  const values: string[] = [];
  for (const candidate of candidates) {
    const normalizedBlock = normalizeGeneratedAnnotationText(candidate);
    if (normalizedBlock && !values.includes(normalizedBlock)) values.push(normalizedBlock);
    for (const line of (candidate || '').split('\n')) {
      const normalizedLine = normalizeGeneratedAnnotationText(line);
      if (normalizedLine && !values.includes(normalizedLine)) values.push(normalizedLine);
    }
  }
  return values;
}

function isGeneratedAnnotationLine(
  line: string,
  generated: string[],
  annotation?: SourceManagedAnnotation,
  imageBasename = ''
): boolean {
  if (/^(?:%%|<!--)\s*zotsidian:/i.test(line)) return true;
  if (/^\[Open in Zotero(?: · [A-Z0-9]+)?\]\([^)]+\)$/i.test(line)) return true;
  if (/^\[Open Zotero image annotation\]\([^)]+\)$/i.test(line)) return true;
  if (/^Open in Zotero(?: · [A-Z0-9]+)?$/i.test(line)) return true;
  if (/^Open Zotero image annotation$/i.test(line)) return true;
  if (/^>\s?/.test(line)) return true;
  if (/^>\s*\[!quote\]/i.test(line)) return true;
  if (/^!\[[^\]]*\]\(<?(?:file:\/\/|\/|https?:\/\/)[^)]+>?\)$/i.test(line)) return true;
  if (/^(?:\*\*)?Comment(?:\*\*)?\s*:/i.test(line)) return true;
  if (/^(?:>\s*)?(?:#+\s*)?(?:Zotero\s+)?(?:highlight|image annotation|annotation)(?:\s*·\s*[\w-]+)?$/i.test(line)) {
    return true;
  }
  if (imageBasename && line.includes(imageBasename)) return true;
  if ((annotation?.annotationType || '').toLowerCase() === 'image' && /^!?\[.*\]\(.+\)$/i.test(line)) return true;

  const comparable = normalizeGeneratedAnnotationText(line);
  if (!comparable) return false;
  if (/^open in zotero(?: [a-z0-9]+)?$/i.test(comparable)) return true;
  if (/^open zotero image annotation$/i.test(comparable)) return true;
  if (/^(?:zotero )?(?:highlight|image annotation|annotation)(?: [\w-]+)?$/i.test(comparable)) return true;
  for (const candidate of generated) {
    if (!candidate) continue;
    if (comparable === candidate) return true;
    if (candidate.length >= 24 && comparable.includes(candidate)) return true;
    if (comparable.length >= 24 && candidate.includes(comparable)) return true;
  }
  return false;
}

function dedupePreservedManualLines(content: string): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const line of (content || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (kept.length > 0 && kept[kept.length - 1].trim() !== '') kept.push(line);
      continue;
    }
    const comparable = normalizeGeneratedAnnotationText(trimmed);
    if (comparable && seen.has(comparable)) continue;
    if (comparable) seen.add(comparable);
    kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeGeneratedAnnotationText(value: string): string {
  return (value || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line
      .replace(/^\s*>\s?/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^>\s*\[!quote\].*$/i, '')
      .trim())
    .join(' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\bOpen in Zotero\b(?:\s*·\s*[A-Z0-9]+)?/gi, ' ')
    .replace(/\bZotero\s+(?:highlight|image annotation)\b(?:\s*·\s*[\w-]+)?/gi, ' ')
    .replace(/\b(?:Comment|Annotation):\s*/gi, ' ')
    .replace(/[`*_#>|[\]().:;,'"!?，。；：！？、]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function getPathBasename(value: string): string {
  const trimmed = (value || '').trim();
  if (!trimmed) return '';
  const withoutScheme = trimmed.startsWith('file://')
    ? decodeURIComponent(trimmed.replace(/^file:\/\//i, ''))
    : trimmed;
  return withoutScheme.split(/[\\/]/).pop()?.replace(/[)>]+$/g, '') || '';
}

function parseLegacyCalloutAnnotationNotes(sectionContent: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = (sectionContent || '').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const linkMatch = lines[index].match(/annotation=([A-Z0-9]+)/i);
    if (!linkMatch?.[1]) continue;
    const key = normalizeAnnotationKey(linkMatch[1]);
    let end = index + 1;
    while (end < lines.length) {
      const candidate = lines[end].trim();
      if (!candidate) {
        end += 1;
        continue;
      }
      if (/^>\s*\[!quote\]/i.test(candidate)) break;
      if (/^\[Open in Zotero · [A-Z0-9]+\]\(/i.test(candidate)) break;
      if (/^###\s+/.test(candidate) || /^##\s+/.test(candidate)) break;
      if (/annotation=[A-Z0-9]+/i.test(candidate)) break;
      end += 1;
    }
    const notes = sanitizePreservedAnnotationNotes(lines.slice(index + 1, end).join('\n'));
    if (notes) result.set(key, notes);
    index = Math.max(index, end - 1);
  }
  return result;
}

function parseLegacyPostItemNotes(sectionContent: string): Map<string, string> {
  const result = new Map<string, string>();
  const itemPattern = /(?:%% zotsidian:item-begin section=annotations key=([^\s]+) %%|<!-- zotsidian:item-begin section=annotations key=([^\s]+) -->)[\s\S]*?(?:%% zotsidian:item-end %%|<!-- zotsidian:item-end -->)/g;
  const matches: Array<{ key: string; start: number; end: number }> = [];
  let match: RegExpExecArray | null = null;
  while ((match = itemPattern.exec(sectionContent)) !== null) {
    matches.push({
      key: normalizeAnnotationKey(match[1] || match[2] || ''),
      start: match.index,
      end: itemPattern.lastIndex,
    });
  }
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    if (!current.key) continue;
    const next = matches[index + 1];
    const rawBetween = sectionContent.slice(current.end, next ? next.start : sectionContent.length);
    const noteLines: string[] = [];
    for (const line of rawBetween.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (noteLines.length > 0) noteLines.push(line);
        continue;
      }
      if (/^(?:%%|<!--)\s*zotsidian:/i.test(trimmed)) break;
      if (/^\[Open in Zotero\b/i.test(trimmed)) break;
      if (/^>\s*\[!quote\]/i.test(trimmed)) break;
      if (/^##\s+|^###\s+/.test(trimmed)) break;
      noteLines.push(line);
    }
    const note = sanitizePreservedAnnotationNotes(noteLines.join('\n'));
    if (note) result.set(current.key, note);
  }
  return result;
}

function parseStructuredAnnotationItems(sectionContent: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = (sectionContent || '').split('\n');
  let index = 0;
  while (index < lines.length) {
    const current = lines[index].trim();
    const matched = current.match(/^\[Open in Zotero · ([A-Z0-9]+)\]\(([^)]+)\)$/);
    if (!matched) {
      index += 1;
      continue;
    }

    const key = normalizeAnnotationKey(matched[1]);
    let scan = index + 1;
    while (scan < lines.length && lines[scan].startsWith('>')) {
      scan += 1;
    }
    while (scan < lines.length && lines[scan].trim() === '') {
      scan += 1;
    }

    while (scan < lines.length && /^\*\*Comment:\*\*/.test(lines[scan].trim())) {
      scan += 1;
      while (scan < lines.length && lines[scan].trim() === '') {
        scan += 1;
      }
    }

    const tailStart = scan;
    while (scan < lines.length) {
      const candidate = lines[scan].trim();
      if (/^\[Open in Zotero · [A-Z0-9]+\]\(([^)]+)\)$/.test(candidate)) break;
      if (/^##\s+/.test(candidate) || /^###\s+/.test(candidate)) break;
      scan += 1;
    }

    const notes = sanitizePreservedAnnotationNotes(lines.slice(tailStart, scan).join('\n'));
    if (notes || !result.has(key)) result.set(key, notes);
    index = scan;
  }
  return result;
}

function stripManagedOpenLinkLines(content: string): string {
  const openLinkPattern =
    /\s*\[(?:Open in Zotero|Open Zotero image annotation)(?: · [A-Z0-9]+)?\]\([^)]+\)/g;
  const lines = (content || '').split('\n');
  const filtered = lines
    .map((line) => line.replace(openLinkPattern, '').trimEnd())
    .filter((line) => line.trim().length > 0);
  return filtered.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function toManagedImportedBlock(content: string): string {
  const normalized = (content || '').trim();
  if (!normalized) return '';
  return normalized
    .split('\n')
    .map((line) => {
      const trimmed = line.trimEnd();
      if (trimmed.trim().length === 0) return '>';
      if (trimmed === '>') return '>';
      if (trimmed.startsWith('> ')) return trimmed;
      return `> ${trimmed}`;
    })
    .join('\n')
    .trim();
}

function renderStructuredManagedAnnotationItem(
  annotation: SourceManagedAnnotation,
  importedContent: string,
  preservedTail: string
): string {
  const key = normalizeAnnotationKey(annotation.key);
  const href = (annotation.openHref || '').trim();
  const anchor = href
    ? `[Open in Zotero · ${key}](${href})`
    : `Open in Zotero · ${key}`;
  const tail = (preservedTail || '').trim();
  return [
    anchor,
    importedContent.trim(),
    tail,
  ].filter((part) => part !== '').join('\n').trim();
}

function buildLocalImageEmbed(localPath: string): string {
  const normalized = (localPath || '').trim();
  if (!normalized) return '';
  const filePath = normalized.startsWith('file://')
    ? decodeURIComponent(normalized.replace(/^file:\/\//i, ''))
    : normalized;
  if (!filePath.startsWith('/')) return '';
  return `![](<file://${encodeURI(filePath)}>)`;
}

function renderManagedAnnotationImport(
  annotation: SourceManagedAnnotation,
  renderers: SourceNoteSyncRenderers
): string {
  const input: AnnotationTemplateInput = {
    key: annotation.key,
    parentItem: annotation.parentItem,
    annotationType: annotation.annotationType,
    annotationColor: annotation.annotationColor,
    annotationComment: annotation.annotationComment,
    annotationTags: annotation.annotationTags,
    annotationPageLabel: annotation.annotationPageLabel,
    annotationPosition: annotation.annotationPosition,
    annotationSortIndex: annotation.annotationSortIndex,
    annotationText: annotation.annotationText,
    annotationImagePath: annotation.annotationImagePath,
    dateAdded: annotation.dateAdded,
    dateModified: annotation.dateModified,
    openHref: annotation.openHref,
    localImagePath: annotation.annotationImagePath || '',
    localImageEmbed: buildLocalImageEmbed(annotation.annotationImagePath || ''),
    formattedDate: annotation.dateModified || annotation.dateAdded || '',
  };
  const kind = (annotation.annotationType || '').trim().toLowerCase() === 'image' ? 'image' : 'text';
  const template = kind === 'image' ? renderers.annotationImageTemplate : renderers.annotationTextTemplate;
  return stripManagedOpenLinkLines(
    renderAnnotationInsertPayloadWithOptionalTemplate(template, input, renderers.annotationBackend).trim()
  );
}

function parseItemKey(itemData: Record<string, unknown>): string {
  const candidates = [
    itemData['itemKey'],
    itemData['zotero-key'],
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^[A-Z0-9]{8}$/i.test(candidate)) {
      return candidate.toUpperCase();
    }
  }
  const uriCandidates = [itemData['zoteroItemID'], itemData['zotero'], itemData['id']];
  for (const uri of uriCandidates) {
    if (typeof uri !== 'string') continue;
    const matched = uri.match(/items\/([A-Z0-9]{8})/i);
    if (matched?.[1]) return matched[1].toUpperCase();
  }
  return '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type ManagedBlockRange = {
  start: number;
  end: number;
  innerStart: number;
  innerEnd: number;
};

function findManagedBlockRange(content: string, section: SourceManagedBlockSection): ManagedBlockRange | null {
  const currentMarkers = getSourceManagedBlockMarkers(section);
  const legacyMarkers = getLegacySourceManagedBlockMarkers(section);
  const markerCandidates = [currentMarkers, legacyMarkers]
    .map((markers) => ({ markers, beginIndex: content.indexOf(markers.begin) }))
    .filter((candidate) => candidate.beginIndex >= 0)
    .sort((a, b) => a.beginIndex - b.beginIndex);

  for (const candidate of markerCandidates) {
    const endIndex = content.indexOf(candidate.markers.end, candidate.beginIndex + candidate.markers.begin.length);
    if (endIndex < 0) continue;
    const beginLineEnd = lineEndIndex(content, candidate.beginIndex);
    const endLineEnd = lineEndIndex(content, endIndex);
    return {
      start: lineStartIndex(content, candidate.beginIndex),
      end: consumeLegacyGeneratedTail(content, endLineEnd),
      innerStart: Math.min(beginLineEnd + 1, content.length),
      innerEnd: endIndex,
    };
  }

  const heading = getSourceManagedBlockHeading(section);
  const headingPattern = new RegExp(`^${escapeRegExp(heading)}\\s*$`, 'm');
  const headingMatch = headingPattern.exec(content);
  if (!headingMatch) return null;
  const headingLineEnd = lineEndIndex(content, headingMatch.index);
  const innerStart = Math.min(headingLineEnd + 1, content.length);
  return {
    start: lineStartIndex(content, headingMatch.index),
    end: findNextSecondLevelHeading(content, innerStart),
    innerStart,
    innerEnd: findNextSecondLevelHeading(content, innerStart),
  };
}

function lineStartIndex(content: string, index: number): number {
  const previous = content.lastIndexOf('\n', Math.max(0, index - 1));
  return previous < 0 ? 0 : previous + 1;
}

function lineEndIndex(content: string, index: number): number {
  const next = content.indexOf('\n', index);
  return next < 0 ? content.length : next;
}

function findNextSecondLevelHeading(content: string, start: number): number {
  const pattern = /^##\s+/gm;
  pattern.lastIndex = start;
  const match = pattern.exec(content);
  return match ? match.index : content.length;
}

function consumeLegacyGeneratedTail(content: string, start: number): number {
  let cursor = start;
  while (cursor < content.length) {
    const nextLineStart = content[cursor] === '\n' ? cursor + 1 : cursor;
    const nextLineEnd = lineEndIndex(content, nextLineStart);
    const line = content.slice(nextLineStart, nextLineEnd);
    const trimmed = line.trim();
    if (!trimmed) {
      cursor = nextLineEnd;
      continue;
    }
    if (
      trimmed.startsWith('>') ||
      /^\[Open in Zotero\b/i.test(trimmed) ||
      /^\*\*Comment:\*\*/i.test(trimmed)
    ) {
      cursor = nextLineEnd;
      continue;
    }
    break;
  }
  return cursor;
}

function normalizeAnnotationKey(key: string): string {
  return (key || '').trim().toUpperCase();
}

function createManagedBlockPattern(section: SourceManagedBlockSection, captureInner = false): RegExp {
  const currentMarkers = getSourceManagedBlockMarkers(section);
  const legacyMarkers = getLegacySourceManagedBlockMarkers(section);
  const heading = getSourceManagedBlockHeading(section);
  const inner = captureInner ? '([\\s\\S]*?)' : '[\\s\\S]*?';
  return new RegExp(
    [
      '(?:',
      [
        [
          `(?:${escapeRegExp(currentMarkers.begin)}|${escapeRegExp(legacyMarkers.begin)})`,
          `\\n?${inner}\\n?`,
          `(?:${escapeRegExp(currentMarkers.end)}|${escapeRegExp(legacyMarkers.end)})(?:[^\\n]*)?(?:\\n(?:\\s*|>.*|\\[Open in Zotero\\].*|\\*\\*Comment:\\*\\*.*))*`,
        ].join(''),
        [
          `(^${escapeRegExp(heading)}\\s*$)`,
          inner,
          `(?=^##\\s+|\\Z)`,
        ].join('\\n?'),
      ].join('|'),
      ')',
    ].join(''),
    'm'
  );
}

function hasManagedHeadingBlock(content: string, heading: string): boolean {
  const pattern = new RegExp(`^${escapeRegExp(heading)}\\s*$`, 'm');
  return pattern.test(content);
}

type StructuredAnnotationItem = {
  key: string;
  notes: string;
};
