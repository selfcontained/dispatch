export type TemplatePromptArg = {
  name: string;
  key: string;
  placeholder: string;
  required: boolean;
  multiline: boolean;
};

export const TEMPLATE_ARG_PATTERN = /\{\{D:([^}]+)\}\}/g;

function parseArgSpec(
  rawSpec: string
): Omit<TemplatePromptArg, "placeholder"> | null {
  const [rawName, ...rawModifiers] = rawSpec.split("|");
  const name = rawName?.trim() ?? "";
  if (!name) return null;

  const modifiers = new Set(
    rawModifiers.map((modifier) => modifier.trim().toLowerCase())
  );

  return {
    name,
    key: name.toLowerCase(),
    required: modifiers.has("required"),
    multiline: modifiers.has("multiline") || modifiers.has("textarea"),
  };
}

export function parseTemplateArgs(prompt: string): TemplatePromptArg[] {
  const regex = new RegExp(
    TEMPLATE_ARG_PATTERN.source,
    TEMPLATE_ARG_PATTERN.flags
  );
  const seen = new Map<string, number>();
  const args: TemplatePromptArg[] = [];
  let match;
  while ((match = regex.exec(prompt)) !== null) {
    const parsed = parseArgSpec(match[1]);
    if (!parsed) continue;
    const existingIndex = seen.get(parsed.key);
    if (existingIndex === undefined) {
      seen.set(parsed.key, args.length);
      args.push({ ...parsed, placeholder: match[0] });
      continue;
    }

    const existing = args[existingIndex];
    args[existingIndex] = {
      ...existing,
      required: existing.required || parsed.required,
      multiline: existing.multiline || parsed.multiline,
    };
  }
  return args;
}

export function substituteArgs(
  prompt: string,
  args: Record<string, string>
): string {
  const parsed = parseTemplateArgs(prompt);
  const missing = parsed.filter(
    (a) => a.required && !(a.key in args) && !(a.name in args)
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required template arguments: ${missing.map((a) => a.name).join(", ")}`
    );
  }
  return prompt.replace(
    new RegExp(TEMPLATE_ARG_PATTERN.source, TEMPLATE_ARG_PATTERN.flags),
    (_match, rawSpec: string) => {
      const parsedArg = parseArgSpec(rawSpec);
      if (!parsedArg) return "";
      return args[parsedArg.key] ?? args[parsedArg.name] ?? "";
    }
  );
}
