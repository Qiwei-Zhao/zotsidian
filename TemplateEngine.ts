import { normalizePath } from 'obsidian';
import type { TemplateBackend, TemplateRenderContext } from 'TemplateBackend';
import { detectTemplateBackendId, getTemplateBackend, resolveTemplateBackendForKind } from 'TemplateBackendRegistry';
import type { TemplateKind } from 'TemplateTypes';

export async function loadTemplateFile(
  configuredPath: string | null | undefined,
  readFile: (path: string) => Promise<string>,
  options?: { stripFrontmatter?: boolean }
): Promise<string> {
  try {
    const trimmed = (configuredPath || '').trim();
    if (!trimmed) return '';
    const content = await readFile(normalizePath(trimmed));
    if (!options?.stripFrontmatter) return content;
    const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
    return match ? match[1].trim() : content.trim();
  } catch (_err) {
    return '';
  }
}

export function getDefaultTemplateBackend(kind: TemplateKind = 'source-body'): TemplateBackend {
  return resolveTemplateBackendForKind(kind);
}

export function renderTemplate(
  template: string,
  context: TemplateRenderContext,
  backend: TemplateBackend = getDefaultTemplateBackend()
): string {
  return backend.render(template, context);
}

export function renderSimpleTemplate(template: string, context: TemplateRenderContext): string {
  return renderTemplate(template, context, getDefaultTemplateBackend());
}

export function renderTemplateForKind(
  kind: TemplateKind,
  template: string,
  context: TemplateRenderContext,
  backend?: TemplateBackend
): string {
  if (backend) return renderTemplate(template, context, backend);
  const detected = getTemplateBackend(detectTemplateBackendId(template));
  return renderTemplate(template, context, detected || getDefaultTemplateBackend(kind));
}
