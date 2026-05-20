import type { TemplateRenderContext } from 'TemplateBackend';
import { getSourceManagedBlockHeading, getSourceManagedBlockMarkers, wrapSourceManagedBlock, type SourceManagedBlockSection } from 'SourceNoteMarkers';

export type SourceTemplateContextInput = {
  citekey: string;
  title: string;
  citationPatch: Record<string, unknown>;
};

export type AnnotationTemplateContextInput = {
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
  annotationAuthorName?: string;
  dateAdded?: string;
  dateModified?: string;
  openHref?: string;
  localImagePath?: string;
  localImageEmbed?: string;
  formattedDate?: string;
};

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function joinStringArray(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).join(', ');
}

function stringifyTemplateValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return '';
  }
}

function normalizeObsidianTag(value: string): string {
  const clean = value.trim().replace(/^#+/, '').replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_/-]/gu, '');
  return clean ? `#${clean}` : '';
}

function buildAnnotationTagsInline(tags: string[]): string {
  return tags.map(normalizeObsidianTag).filter(Boolean).join(' ');
}

function buildAnnotationColorDot(color: string): string {
  const clean = color.trim();
  if (!/^#[0-9a-f]{3,8}$/i.test(clean)) return '';
  return `<span style="color: ${clean}">●</span>`;
}

export function createSourceTemplateContext(input: SourceTemplateContextInput): TemplateRenderContext {
  const normalizedCitekey = input.citekey.replace(/^@+/, '').trim();
  const authors = joinStringArray(input.citationPatch.authors);
  const year = input.citationPatch.year == null ? '' : String(input.citationPatch.year);
  const doi = asTrimmedString(input.citationPatch.DOI);
  const journal = asTrimmedString(input.citationPatch.journal);
  const abstractText = asTrimmedString(input.citationPatch.abstract);
  const zotero = asTrimmedString(input.citationPatch.zotero);
  const zoteroKey = asTrimmedString(input.citationPatch['zotero-key']);
  const itemType = asTrimmedString(input.citationPatch.itemType);

  const item = {
    citekey: normalizedCitekey,
    atCitekey: `@${normalizedCitekey}`,
    title: input.title || '',
    authors,
    year,
    doi,
    DOI: doi,
    journal,
    abstract: abstractText,
    zotero,
    zoteroKey,
    itemType,
  };

  const managed = {
    metadata: { ...getSourceManagedBlockMarkers('metadata'), heading: getSourceManagedBlockHeading('metadata') },
    annotations: { ...getSourceManagedBlockMarkers('annotations'), heading: getSourceManagedBlockHeading('annotations') },
    related: { ...getSourceManagedBlockMarkers('related'), heading: getSourceManagedBlockHeading('related') },
    references: { ...getSourceManagedBlockMarkers('references'), heading: getSourceManagedBlockHeading('references') },
    citations: { ...getSourceManagedBlockMarkers('citations'), heading: getSourceManagedBlockHeading('citations') },
    discourse: { ...getSourceManagedBlockMarkers('discourse'), heading: getSourceManagedBlockHeading('discourse') },
  };

  return {
    citekey: normalizedCitekey,
    atCitekey: `@${normalizedCitekey}`,
    title: input.title || '',
    authors,
    year,
    doi,
    DOI: doi,
    journal,
    abstract: abstractText,
    zotero,
    zoteroKey,
    itemType,
    item,
    source: {
      citekey: normalizedCitekey,
      title: input.title || '',
    },
    managed,
    helpers: {
      wrapManagedBlock: (section: SourceManagedBlockSection, content: string) => wrapSourceManagedBlock(section, content),
    },
  };
}

export function createAnnotationTemplateContext(input: AnnotationTemplateContextInput): TemplateRenderContext {
  const parts: string[] = [];
  const text = asTrimmedString(input.annotationText);
  const comment = asTrimmedString(input.annotationComment);
  const localImagePath = asTrimmedString(input.localImagePath);
  const localImageEmbed = typeof input.localImageEmbed === 'string' ? input.localImageEmbed : '';
  const openHref = asTrimmedString(input.openHref);
  const type = asTrimmedString(input.annotationType).toLowerCase() || 'annotation';
  const position = stringifyTemplateValue(input.annotationPosition);
  const tags = Array.isArray(input.annotationTags)
    ? input.annotationTags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
    : [];
  const annotationColor = asTrimmedString(input.annotationColor);
  const annotationColorDot = buildAnnotationColorDot(annotationColor);
  const annotationTagsInline = buildAnnotationTagsInline(tags);
  const annotationMetaInline = [annotationColorDot, annotationTagsInline].filter(Boolean).join(' ');
  const calloutLines: string[] = [];
  const calloutQuoteLines: string[] = [];
  const pushCalloutBlock = (value: string) => {
    const normalized = value.trim();
    if (!normalized) return;
    for (const line of normalized.split(/\r?\n/)) {
      calloutLines.push(`> ${line}`);
    }
  };
  const pushCalloutQuoteBlock = (value: string) => {
    const normalized = value.trim();
    if (!normalized) return;
    for (const line of normalized.split(/\r?\n/)) {
      calloutQuoteLines.push(`> ${line}`);
    }
  };

  if (type === 'image') {
    if (localImageEmbed) {
      parts.push(localImageEmbed);
      pushCalloutBlock(localImageEmbed);
      pushCalloutQuoteBlock(localImageEmbed);
    } else if (openHref) {
      parts.push(`[Open Zotero image annotation](${openHref})`);
      pushCalloutBlock(`[Open Zotero image annotation](${openHref})`);
      pushCalloutQuoteBlock(`[Open Zotero image annotation](${openHref})`);
    }
    if (text) {
      parts.push(`> ${text.replace(/\n/g, '\n> ')}`);
      pushCalloutBlock(text);
      pushCalloutQuoteBlock(text);
    }
    if (comment) {
      parts.push(comment);
      pushCalloutBlock(comment);
    }
  } else {
    if (text) {
      parts.push(`> ${text.replace(/\n/g, '\n> ')}`);
      pushCalloutBlock(text);
      pushCalloutQuoteBlock(text);
    }
    if (comment) {
      parts.push(comment);
      pushCalloutBlock(comment);
    }
    if (!text && !comment) {
      if (localImageEmbed) {
        parts.push(localImageEmbed);
        pushCalloutBlock(localImageEmbed);
        pushCalloutQuoteBlock(localImageEmbed);
      } else if (openHref) {
        parts.push(`[Open Zotero image annotation](${openHref})`);
        pushCalloutBlock(`[Open Zotero image annotation](${openHref})`);
        pushCalloutQuoteBlock(`[Open Zotero image annotation](${openHref})`);
      }
    }
  }

  const defaultPayload = parts.join('\n\n').trim();
  const quoteBlock = text ? `> ${text.replace(/\n/g, '\n> ')}` : '';
  const calloutContent = calloutLines.join('\n');
  const calloutQuoteContent = calloutQuoteLines.join('\n');
  const commentBlock = comment ? `**Comment:** ${comment}` : '';

  const annotation = {
    key: input.key || '',
    parentItem: input.parentItem || '',
    type,
    color: annotationColor,
    colorDot: annotationColorDot,
    tagsInline: annotationTagsInline,
    metaInline: annotationMetaInline,
    tags,
    tag: tags[0] || '',
    pageLabel: asTrimmedString(input.annotationPageLabel),
    position,
    sortIndex: asTrimmedString(input.annotationSortIndex),
    text,
    comment,
    authorName: asTrimmedString(input.annotationAuthorName),
    dateAdded: asTrimmedString(input.dateAdded),
    dateModified: asTrimmedString(input.dateModified),
    date: input.formattedDate || '',
    localImagePath,
    localImageEmbed,
    zoteroOpenHref: openHref,
    openHref,
    quoteBlock,
    calloutContent,
    calloutQuoteContent,
    commentBlock,
    defaultPayload,
  };

  return {
    annotationKey: input.key || '',
    parentItem: input.parentItem || '',
    annotationType: type,
    annotationColor,
    annotationColorDot,
    annotationTags: tags,
    annotationTagsInline,
    annotationTag: tags[0] || '',
    annotationMetaInline,
    annotationPageLabel: asTrimmedString(input.annotationPageLabel),
    annotationPosition: position,
    annotationSortIndex: asTrimmedString(input.annotationSortIndex),
    annotationText: text,
    annotationComment: comment,
    annotationAuthorName: asTrimmedString(input.annotationAuthorName),
    dateAdded: asTrimmedString(input.dateAdded),
    dateModified: asTrimmedString(input.dateModified),
    date: input.formattedDate || '',
    localImagePath,
    localImageEmbed,
    zoteroOpenHref: openHref,
    openHref,
    quoteBlock,
    calloutContent,
    calloutQuoteContent,
    commentBlock,
    defaultPayload,
    annotation,
    item: {
      citekey: input.parentItem || '',
    },
  };
}
