import { buildSelfImprovementGuidance } from "../shared/self-improvement-prompt.js";
import { parseTemplateArgs, substituteArgs } from "./arg-parser.js";
import type { TemplateRecord } from "./store.js";

export type RenderableTemplate = Pick<TemplateRecord, "id" | "selfImprove"> & {
  prompt: string;
};

export type RenderedTemplatePrompt = {
  prompt: string;
  /** Args nothing supplied a value for — they rendered empty. */
  unfilled: string[];
  /** Supplied keys matching no arg in the template — nothing consumed them. */
  unknownArgs: string[];
};

/**
 * The one place a template's prompt becomes an agent's startup prompt. Every
 * launch surface goes through here so the assembly rule — substitute args,
 * then the caller's own text, then the self-improvement footer — cannot drift
 * between them.
 */
export function renderTemplatePrompt(
  template: RenderableTemplate,
  args: Record<string, string>,
  appendix?: string
): string {
  const parsed = parseTemplateArgs(template.prompt);
  let prompt =
    parsed.length > 0 ? substituteArgs(template.prompt, args) : template.prompt;
  if (appendix) prompt = `${prompt.trimEnd()}\n\n${appendix}`;
  if (template.selfImprove) {
    prompt += buildSelfImprovementGuidance({
      kind: "template",
      templateId: template.id,
    });
  }
  return prompt;
}

/**
 * Renders a template for a caller that supplies free text instead of the web
 * UI's per-arg form values — an MCP launch.
 *
 * Its job is resolving that free text into args; the assembly itself belongs to
 * renderTemplatePrompt. A single arg left unset after `callerArgs` takes the
 * free text, the unambiguous case — unless some `callerArgs` key matched no arg
 * at all, which is evidence the caller was aiming a different value at that
 * slot. Free text that fills nothing follows the rendered template instead.
 * Args nobody supplies render empty and come back in `unfilled`, so a
 * partly-specified launch degrades visibly rather than failing or leaking
 * `{{D:...}}` into the agent's prompt.
 */
export function renderTemplatePromptFromFreeText(
  template: RenderableTemplate,
  callerPrompt: string,
  callerArgs?: Record<string, string>
): RenderedTemplatePrompt {
  const parsed = parseTemplateArgs(template.prompt);
  // A null-prototype dictionary, so an arg named after an Object member
  // ({{D:toString}}) neither reads as pre-filled nor renders as a built-in.
  const args: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(callerArgs ?? {}))
    args[key] = value;

  const hasValue = (arg: (typeof parsed)[number]): boolean =>
    args[arg.key] != null || args[arg.name] != null;

  const known = new Set(parsed.flatMap((arg) => [arg.key, arg.name]));
  const unknownArgs = Object.keys(callerArgs ?? {}).filter(
    (key) => !known.has(key)
  );

  const text = callerPrompt.trim();
  const missing = parsed.filter((arg) => !hasValue(arg));
  // An unmatched key is evidence the caller meant to supply that value, so the
  // free text must not take the slot they were aiming at — leaving the arg
  // unfilled is what makes the mistake visible in the note.
  const fillsArg =
    text !== "" && missing.length === 1 && unknownArgs.length === 0;
  if (fillsArg) args[missing[0].key] = text;

  const unfilled = parsed.filter((arg) => !hasValue(arg));
  // Collapse to key space: substituteArgs resolves each occurrence by its own
  // spelling, so a name-keyed value has to be reachable under the lowercased
  // key too, or an arg written in two cases half-renders. The "" also keeps
  // substituteArgs from throwing over an arg nobody supplied.
  for (const arg of parsed)
    args[arg.key] = args[arg.key] ?? args[arg.name] ?? "";

  return {
    prompt: renderTemplatePrompt(
      template,
      args,
      fillsArg || text === "" ? undefined : text
    ),
    unfilled: unfilled.map((arg) => arg.name),
    unknownArgs,
  };
}
