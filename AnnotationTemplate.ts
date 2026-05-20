import { renderTemplateForKind } from 'TemplateEngine';
import { createAnnotationTemplateContext } from 'TemplateContext';
import type { TemplateBackend, TemplateRenderContext } from 'TemplateBackend';

export type AnnotationTemplateInput = {
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

export type AnnotationTemplatePreset = 'default' | 'callout' | 'custom';

export function normalizeAnnotationTemplatePreset(value: string | null | undefined): AnnotationTemplatePreset {
  if (value === 'callout' || value === 'custom') return value;
  return 'default';
}

export function resolveAnnotationTemplateKind(input: AnnotationTemplateInput): 'annotation-text' | 'annotation-image' {
  return ((input.annotationType || '').trim().toLowerCase() === 'image') ? 'annotation-image' : 'annotation-text';
}

export function getBuiltInAnnotationTemplate(
  preset: AnnotationTemplatePreset,
  kind: 'text' | 'image',
): string {
  if (preset !== 'callout') return '';
  if (kind === 'image') {
    return [
      '> [!quote] {{annotationMetaInline}} Zotero image annotation · {{parentItem}}',
      '{{calloutQuoteContent}}',
      '>',
      '> [Open in Zotero]({{openHref}})',
      '',
      '{{commentBlock}}',
    ].join('\n');
  }
  return [
    '> [!quote] {{annotationMetaInline}} Zotero highlight · {{parentItem}}',
    '{{calloutQuoteContent}}',
    '>',
    '> [Open in Zotero]({{openHref}})',
    '',
    '{{commentBlock}}',
  ].join('\n');
}

export function buildAnnotationInsertTemplateContext(input: AnnotationTemplateInput): TemplateRenderContext {
  return createAnnotationTemplateContext(input);
}

export function renderAnnotationInsertPayload(template: string, input: AnnotationTemplateInput, backend?: TemplateBackend): string {
  return renderTemplateForKind(resolveAnnotationTemplateKind(input), template, buildAnnotationInsertTemplateContext(input), backend).trim();
}

export function buildDefaultAnnotationInsertPayload(input: AnnotationTemplateInput): string {
  const context = buildAnnotationInsertTemplateContext(input);
  return typeof context.defaultPayload === 'string' ? context.defaultPayload.trim() : '';
}

export function renderAnnotationInsertPayloadWithOptionalTemplate(
  template: string,
  input: AnnotationTemplateInput,
  backend?: TemplateBackend
): string {
  const normalizedTemplate = (template || '').trim();
  if (normalizedTemplate) {
    return renderAnnotationInsertPayload(normalizedTemplate, input, backend).trim();
  }
  return buildDefaultAnnotationInsertPayload(input);
}
