import { parseTemplateArgs, substituteArgs } from "./arg-parser.js";

export type RenderedTemplatePrompt = {
  prompt: string;
  /** Variables nothing supplied a value for — they rendered empty. */
  unfilled: string[];
};

/**
 * Builds the startup prompt for an MCP launch that names a template: the
 * template's own prompt with its `{{D:...}}` variables rendered, then the
 * caller's prompt.
 *
 * The web UI collects one value per variable from a form; an MCP caller sends
 * `args` plus one free-text prompt. A single variable left over after `args`
 * takes that free text — the unambiguous case — and otherwise the free text
 * follows the rendered template. Variables nobody supplied render empty and are
 * reported back, so a launch degrades visibly rather than leaking `{{D:...}}`
 * into the agent's prompt or failing outright.
 */
export function renderTemplateLaunchPrompt(
  templatePrompt: string,
  callerPrompt: string,
  callerArgs?: Record<string, string>
): RenderedTemplatePrompt {
  const parsed = parseTemplateArgs(templatePrompt);
  // A null-prototype dictionary, so a variable named after an Object member
  // ({{D:toString}}) neither reads as pre-filled nor renders as a built-in.
  const args: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(callerArgs ?? {}))
    args[key] = value;

  const hasValue = (arg: (typeof parsed)[number]): boolean =>
    args[arg.key] != null || args[arg.name] != null;

  const text = callerPrompt.trim();
  const missing = parsed.filter((arg) => !hasValue(arg));
  const fillsVariable = text !== "" && missing.length === 1;
  if (fillsVariable) args[missing[0].key] = text;

  const unfilled = parsed.filter((arg) => !hasValue(arg));
  // substituteArgs throws over a required arg nobody supplied; an explicit
  // empty value keeps a partly-specified launch working.
  for (const arg of unfilled) args[arg.key] = "";

  const rendered =
    parsed.length > 0 ? substituteArgs(templatePrompt, args) : templatePrompt;

  return {
    prompt:
      text === "" || fillsVariable
        ? rendered
        : `${rendered.trimEnd()}\n\n${text}`,
    unfilled: unfilled.map((arg) => arg.name),
  };
}
