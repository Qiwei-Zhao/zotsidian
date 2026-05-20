import { SimplePlaceholderTemplateBackend, type TemplateBackend } from 'TemplateBackend';
import { EtaTemplateBackend } from 'EtaTemplateBackend';
import type { TemplateKind } from 'TemplateTypes';

export type TemplateBackendId = 'simple-placeholder' | 'eta';

const simplePlaceholderBackend = new SimplePlaceholderTemplateBackend();
const etaBackend = new EtaTemplateBackend();

const TEMPLATE_BACKENDS: Record<TemplateBackendId, TemplateBackend> = {
  'simple-placeholder': simplePlaceholderBackend,
  eta: etaBackend,
};

export function getTemplateBackend(id: TemplateBackendId): TemplateBackend | null {
  return TEMPLATE_BACKENDS[id] || null;
}

export function getDefaultTemplateBackendIdForKind(_kind: TemplateKind): TemplateBackendId {
  return 'simple-placeholder';
}

export function resolveTemplateBackendForKind(kind: TemplateKind): TemplateBackend {
  const backend = getTemplateBackend(getDefaultTemplateBackendIdForKind(kind));
  return backend || simplePlaceholderBackend;
}

export function detectTemplateBackendId(template: string, fallback: TemplateBackendId = 'simple-placeholder'): TemplateBackendId {
  const normalized = (template || '').trim();
  if (!normalized) return fallback;
  if (/<%[\s\S]*?%>/.test(normalized)) return 'eta';
  return fallback;
}
