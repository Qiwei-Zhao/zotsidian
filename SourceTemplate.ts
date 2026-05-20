import { loadTemplateFile, renderTemplateForKind } from 'TemplateEngine';
import { createSourceTemplateContext } from 'TemplateContext';
import type { TemplateBackend, TemplateRenderContext } from 'TemplateBackend';

export type SourceFrontmatterMode = 'built-in-and-template' | 'template-only' | 'minimal';
export type SourcePagePreset = 'minimal' | 'reading' | 'review' | 'custom';
export type SourceManagedSectionMode = 'off' | 'managed';

export function normalizeSourceFrontmatterMode(value: string | null | undefined): SourceFrontmatterMode {
  if (value === 'template-only' || value === 'minimal') return value;
  return 'built-in-and-template';
}

export function normalizeSourcePagePreset(value: string | null | undefined): SourcePagePreset {
  if (value === 'minimal' || value === 'reading' || value === 'review' || value === 'custom') return value;
  return 'reading';
}

export function normalizeSourceManagedSectionMode(value: string | null | undefined): SourceManagedSectionMode {
  return value === 'off' ? 'off' : 'managed';
}

export function getBuiltInSourceFrontmatterDefaults(): Record<string, unknown> {
  return {
    dg_type: 'Source',
    status: 'seed',
    keywords: '',
    rating: 3,
    tags: ['dg/source'],
  };
}

export type ParsedTemplateDocument = {
  frontmatterDefaults: Record<string, unknown>;
  body: string;
};

function parseFrontmatterDefaults(frontmatterBlock: string): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const line of frontmatterBlock.split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*:\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    const raw = m[2];
    if (raw === '""' || raw === "''") defaults[key] = '';
    else if (raw.startsWith('[') && raw.endsWith(']')) {
      defaults[key] = raw.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean).map((x) => x.replace(/^['\"]|['\"]$/g, ''));
    } else if (!Number.isNaN(Number(raw)) && raw !== '') defaults[key] = Number(raw);
    else defaults[key] = raw.replace(/^['\"]|['\"]$/g, '');
  }
  return defaults;
}

export function parseTemplateDocument(content: string): ParsedTemplateDocument {
  if (!content) {
    return {
      frontmatterDefaults: {},
      body: '',
    };
  }
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return {
      frontmatterDefaults: {},
      body: content.trim(),
    };
  }
  return {
    frontmatterDefaults: parseFrontmatterDefaults(match[1]),
    body: (match[2] || '').trim(),
  };
}

export function getSourceFrontmatterDefaults(mode: SourceFrontmatterMode, templateDefaults: Record<string, unknown>): Record<string, unknown> {
  switch (mode) {
    case 'minimal':
      return {};
    case 'template-only':
      return { ...templateDefaults };
    case 'built-in-and-template':
    default:
      return { ...getBuiltInSourceFrontmatterDefaults(), ...templateDefaults };
  }
}

export function getRequiredSourceFrontmatterPatch(citekey: string, title: string, citationPatch: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    ...citationPatch,
  };
  if (!patch.citekey) patch.citekey = citekey;
  if (title && !patch.title) patch.title = title;
  return patch;
}

export function getDiscourseSourceFrontmatterPatch(discourseSourceNodeTypeId: string | null | undefined): Record<string, unknown> {
  if (!discourseSourceNodeTypeId) return {};
  return {
    nodeTypeId: discourseSourceNodeTypeId,
  };
}

export async function loadSourceTemplateDefaults(
  configuredPath: string | null | undefined,
  readFile: (path: string) => Promise<string>
): Promise<Record<string, unknown>> {
  const content = await loadTemplateFile(configuredPath, readFile);
  return parseTemplateDocument(content).frontmatterDefaults;
}

export async function loadSourceBodyTemplate(
  configuredPath: string | null | undefined,
  readFile: (path: string) => Promise<string>
): Promise<string> {
  return loadTemplateFile(configuredPath, readFile, { stripFrontmatter: true });
}

export async function loadSourceFullNoteTemplate(
  configuredPath: string | null | undefined,
  readFile: (path: string) => Promise<string>
): Promise<string> {
  return loadTemplateFile(configuredPath, readFile);
}

export async function loadSourceFullNoteTemplateDocument(
  configuredPath: string | null | undefined,
  readFile: (path: string) => Promise<string>
): Promise<ParsedTemplateDocument> {
  const content = await loadSourceFullNoteTemplate(configuredPath, readFile);
  return parseTemplateDocument(content);
}

export function buildSourceBodyTemplateContext(citekey: string, title: string, citationPatch: Record<string, unknown>): TemplateRenderContext {
  return createSourceTemplateContext({
    citekey,
    title,
    citationPatch,
  });
}

export function buildInitialSourcePageContent(
  citekey: string,
  title: string,
  citationPatch: Record<string, unknown>,
  bodyTemplate: string,
  fullNoteTemplate: string,
  backend?: TemplateBackend
): string {
  const normalizedCitekey = citekey.replace(/^@+/, '').trim();
  const context = buildSourceBodyTemplateContext(normalizedCitekey, title, citationPatch);
  if (fullNoteTemplate) {
    const rendered = renderTemplateForKind('source-full-note', fullNoteTemplate, context, backend).trim();
    if (rendered) return `${rendered}\n`;
  }
  const body = bodyTemplate
    ? renderTemplateForKind('source-body', bodyTemplate, context, backend).trim()
    : `# @${normalizedCitekey}`;
  const finalBody = body || `# @${normalizedCitekey}`;
  return `${finalBody}\n`;
}

export function getBuiltInSourceFullNoteTemplate(
  preset: SourcePagePreset,
  layout?: {
    annotations?: SourceManagedSectionMode;
    related?: SourceManagedSectionMode;
    references?: SourceManagedSectionMode;
    citations?: SourceManagedSectionMode;
  }
): string {
  if (preset === 'custom') return '';
  const sections: string[] = [
    '# <%= it.item.title %>',
    '',
    'Citekey: <%= it.item.atCitekey %>',
  ];

  const blockOrder: Array<[SourceManagedSectionMode | undefined, string, string]> = [
    [layout?.annotations, 'annotations', '## Annotations'],
    [layout?.related, 'related', '## Related'],
    [layout?.references, 'references', '## References'],
    [layout?.citations, 'citations', '## Citations'],
  ];

  for (const [mode, section, heading] of blockOrder) {
    if (mode !== 'managed') continue;
    sections.push('', `<%= it.helpers.wrapManagedBlock('${section}', '${heading}') %>`);
  }

  return sections.join('\n');
}
