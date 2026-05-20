export type TemplateKind =
  | 'source-frontmatter'
  | 'source-body'
  | 'annotation-text'
  | 'annotation-image'
  | 'annotation-batch'
  | 'source-full-note';

export type ConfigurableTemplateKind =
  | 'source-full-note'
  | 'source-frontmatter'
  | 'source-body'
  | 'annotation-text'
  | 'annotation-image';

export type TemplateSettingPaths = {
  sourceFullNoteTemplatePath?: string;
  sourceTemplatePath?: string;
  sourceBodyTemplatePath?: string;
  annotationTextTemplatePath?: string;
  annotationImageTemplatePath?: string;
};

export type TemplateDefinition = {
  kind: TemplateKind;
  label: string;
  description: string;
  configurable: boolean;
  settingKey?: keyof TemplateSettingPaths;
};
