export type TemplateRenderFunction = (...args: any[]) => TemplateRenderValue;

export type TemplateRenderValue =
  | string
  | number
  | boolean
  | TemplateRenderFunction
  | null
  | undefined
  | TemplateRenderValue[]
  | { [key: string]: TemplateRenderValue };

export type TemplateRenderContext = Record<string, TemplateRenderValue>;

export interface TemplateBackend {
  readonly name: string;
  render(template: string, context: TemplateRenderContext): string;
}

export class SimplePlaceholderTemplateBackend implements TemplateBackend {
  readonly name = 'simple-placeholder';

  render(template: string, context: TemplateRenderContext): string {
    return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, key: string) => {
      if (!Object.prototype.hasOwnProperty.call(context, key)) return '';
      const value = context[key];
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : '';
    });
  }
}
