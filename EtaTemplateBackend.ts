import { Eta } from 'eta';
import type { TemplateBackend, TemplateRenderContext } from 'TemplateBackend';

const eta = new (Eta as any)();
eta.configure({
  autoEscape: false,
  useWith: true,
});

export class EtaTemplateBackend implements TemplateBackend {
  readonly name = 'eta';

  render(template: string, context: TemplateRenderContext): string {
    return ((eta as any).renderString(template, context) || '') as string;
  }
}
