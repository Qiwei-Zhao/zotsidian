import type { ConfigurableTemplateKind, TemplateDefinition, TemplateKind, TemplateSettingPaths } from 'TemplateTypes';

const TEMPLATE_DEFINITIONS: TemplateDefinition[] = [
  {
    kind: 'source-full-note',
    label: 'Source full note',
    description: 'Complete template for newly created source pages, including optional frontmatter and managed blocks.',
    configurable: true,
    settingKey: 'sourceFullNoteTemplatePath',
  },
  {
    kind: 'source-frontmatter',
    label: 'Source frontmatter',
    description: 'Frontmatter defaults applied when creating source pages.',
    configurable: true,
    settingKey: 'sourceTemplatePath',
  },
  {
    kind: 'source-body',
    label: 'Source body',
    description: 'Initial body template for newly created source pages.',
    configurable: true,
    settingKey: 'sourceBodyTemplatePath',
  },
  {
    kind: 'annotation-text',
    label: 'Annotation text',
    description: 'Template for inserting text annotations into Markdown.',
    configurable: true,
    settingKey: 'annotationTextTemplatePath',
  },
  {
    kind: 'annotation-image',
    label: 'Annotation image',
    description: 'Template for inserting image annotations into Markdown.',
    configurable: true,
    settingKey: 'annotationImageTemplatePath',
  },
  {
    kind: 'annotation-batch',
    label: 'Annotation batch',
    description: 'Reserved for future batch annotation templating.',
    configurable: false,
  },
];

export function listTemplateDefinitions(): TemplateDefinition[] {
  return TEMPLATE_DEFINITIONS.slice();
}

export function getTemplateDefinition(kind: TemplateKind): TemplateDefinition | undefined {
  return TEMPLATE_DEFINITIONS.find((definition) => definition.kind === kind);
}

export function isConfigurableTemplateKind(kind: TemplateKind): kind is ConfigurableTemplateKind {
  return Boolean(getTemplateDefinition(kind)?.configurable);
}

export function getConfiguredTemplatePath(settings: TemplateSettingPaths, kind: ConfigurableTemplateKind): string {
  const definition = getTemplateDefinition(kind);
  const settingKey = definition?.settingKey;
  if (!settingKey) return '';
  return (settings[settingKey] || '').trim();
}
