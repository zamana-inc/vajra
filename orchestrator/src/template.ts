import { Liquid } from "liquidjs";

export function createTemplateEngine(opts?: {
  strictVariables?: boolean;
}): Liquid {
  const engine = new Liquid({
    strictFilters: true,
    strictVariables: opts?.strictVariables ?? true,
  });

  engine.registerFilter("shellquote", (value: unknown) => {
    const text = String(value ?? "");
    return `'${text.replace(/'/g, `'\"'\"'`)}'`;
  });

  return engine;
}

const sharedStrictTemplateEngine = createTemplateEngine({
  strictVariables: true,
});
const sharedPromptTemplateEngine = createTemplateEngine({
  strictVariables: false,
});

async function renderStrictTemplate(template: string, scope: Record<string, unknown>): Promise<string> {
  return sharedStrictTemplateEngine.parseAndRender(template, scope);
}

export async function renderPromptTemplate(template: string, scope: Record<string, unknown>): Promise<string> {
  return sharedPromptTemplateEngine.parseAndRender(template, scope);
}

// Prompts are lenient, but command and condition templates must stay strict.
export async function renderCommandTemplate(template: string, scope: Record<string, unknown>): Promise<string> {
  return renderStrictTemplate(template, scope);
}

export async function renderConditionTemplate(template: string, scope: Record<string, unknown>): Promise<string> {
  return renderStrictTemplate(template, scope);
}
