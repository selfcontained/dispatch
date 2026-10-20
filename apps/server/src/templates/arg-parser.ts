export type TemplatePromptArg = {
  name: string;
  key: string;
  placeholder: string;
  required: boolean;
  multiline: boolean;
  default?: string;
  options?: string[];
  /** Kept as data so incomplete declarations remain editable in the UI. */
  error?: string;
};

export const TEMPLATE_ARG_PATTERN =
  /\{\{D:((?:\\[|,}\\]|\\(?![|,}\\])|[^}\\])+)\}\}/g;

// Preserve escapes until all delimiter splitting is complete. Ordinary
// backslashes (e.g. Windows paths) are never consumed.
function splitSpec(value: string, delimiter: string): string[] {
  const parts = [""];
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "\\" && /[|,}\\]/.test(value[i + 1] ?? "")) {
      parts[parts.length - 1] += char + value[++i];
    } else if (char === delimiter) parts.push("");
    else parts[parts.length - 1] += char;
  }
  return parts;
}

function decode(value: string): string {
  return value.trim().replace(/\\([|,}\\])/g, "$1");
}

function mergeDeclaration(
  arg: TemplatePromptArg,
  field: "default" | "options",
  value: string | string[]
): void {
  if (
    arg[field] !== undefined &&
    JSON.stringify(arg[field]) !== JSON.stringify(value)
  ) {
    arg.error = `Conflicting ${field} declarations for template argument "${arg.name}". Use the same ${field} on every occurrence.`;
  } else if (field === "default") arg.default = value as string;
  else arg.options = value as string[];
}

function parseArgSpec(
  rawSpec: string,
  placeholder: string
): TemplatePromptArg | null {
  const [rawName, ...modifiers] = splitSpec(rawSpec, "|");
  const name = decode(rawName ?? "");
  if (!name) return null;
  const arg: TemplatePromptArg = {
    name,
    key: name.toLowerCase(),
    placeholder,
    required: false,
    multiline: false,
  };
  for (const raw of modifiers) {
    const equals = raw.indexOf("=");
    const modifier = (equals < 0 ? raw : raw.slice(0, equals))
      .trim()
      .toLowerCase();
    const value = raw.slice(equals + 1);
    if (equals < 0 && modifier === "required") arg.required = true;
    if (equals < 0 && (modifier === "multiline" || modifier === "textarea"))
      arg.multiline = true;
    if (equals >= 0 && modifier === "default")
      mergeDeclaration(arg, "default", decode(value));
    if (equals >= 0 && modifier === "options")
      mergeDeclaration(arg, "options", splitSpec(value, ",").map(decode));
  }
  return arg;
}

export function parseTemplateArgs(prompt: string): TemplatePromptArg[] {
  const seen = new Map<string, TemplatePromptArg>();
  for (const match of prompt.matchAll(new RegExp(TEMPLATE_ARG_PATTERN))) {
    const parsed = parseArgSpec(match[1], match[0]);
    if (!parsed) continue;
    const existing = seen.get(parsed.key);
    if (!existing) {
      seen.set(parsed.key, parsed);
      continue;
    }
    existing.required ||= parsed.required;
    existing.multiline ||= parsed.multiline;
    if (parsed.error) existing.error = parsed.error;
    if (parsed.default !== undefined)
      mergeDeclaration(existing, "default", parsed.default);
    if (parsed.options !== undefined)
      mergeDeclaration(existing, "options", parsed.options);
  }
  for (const arg of seen.values()) {
    if (arg.options?.some((option) => option === ""))
      arg.error = `Invalid options for template argument "${arg.name}": choices must be nonempty.`;
    if (
      arg.default !== undefined &&
      arg.default !== "" &&
      arg.options &&
      !arg.options.includes(arg.default)
    )
      arg.error = `Invalid default for template argument "${arg.name}": choose one of ${arg.options.join(", ")}.`;
    if (arg.required && arg.default !== undefined && !arg.default.trim())
      arg.error = `Invalid default for required template argument "${arg.name}": provide a nonblank value.`;
  }
  return [...seen.values()];
}

export function templateArgDefaults(
  args: TemplatePromptArg[]
): Record<string, string> {
  return Object.fromEntries(
    args
      .filter((arg) => arg.default !== undefined)
      .map((arg) => [arg.key, arg.default!])
  );
}

export function substituteArgs(
  prompt: string,
  args: Record<string, string>
): string {
  const values = new Map<string, string>();
  const parsed = parseTemplateArgs(prompt);
  const own = (key: string) =>
    Object.prototype.hasOwnProperty.call(args, key) ? args[key] : undefined;
  const resolve = (arg: TemplatePromptArg) =>
    own(arg.key) ?? own(arg.name) ?? arg.default ?? "";
  const missing = parsed.filter((arg) => arg.required && !resolve(arg).trim());
  const error = parsed.find((arg) => arg.error)?.error;
  if (error) throw new Error(error);
  if (missing.length)
    throw new Error(
      `Missing required template arguments: ${missing.map((arg) => arg.name).join(", ")}`
    );
  for (const arg of parsed) {
    const value = resolve(arg);
    if (value !== "" && arg.options && !arg.options.includes(value))
      throw new Error(
        `Invalid value for template argument "${arg.name}": choose one of ${arg.options.join(", ")}.`
      );
    values.set(arg.key, value);
  }
  return prompt.replace(
    new RegExp(TEMPLATE_ARG_PATTERN),
    (_match, rawSpec: string) => {
      const arg = parseArgSpec(rawSpec, _match);
      return arg ? (values.get(arg.key) ?? "") : "";
    }
  );
}
