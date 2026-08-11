import { parseTemplateArgs, substituteArgs } from "./arg-parser.js";

export type RenderedTemplatePrompt = {
  /** The template's prompt with placeholders substituted, plus any leftover
   * caller instructions appended. */
  prompt: string;
  /** Placeholder the caller's free-text prompt was substituted into, if any. */
  filledFromPrompt: string | null;
  /** Placeholders nothing supplied a value for — rendered as empty strings. */
  unfilled: string[];
  /** True when the caller's prompt was appended rather than substituted. */
  appendedCallerPrompt: boolean;
};

const APPENDED_PROMPT_HEADING =
  "## Additional instructions from the launching agent";

/**
 * Renders a template's prompt for a launch that supplies free text rather than
 * the structured, per-placeholder args the web UI's launch form collects.
 *
 * The template prompt is always used in full — that is the point of launching a
 * template. Placeholders are filled from `args` when given; a single remaining
 * placeholder absorbs the caller's free text, which is the unambiguous case.
 * Anything the caller said that did not become a placeholder value is appended
 * instead of dropped, and placeholders nobody supplied render empty rather than
 * failing the launch or leaking a literal `{{D:...}}` into the prompt.
 */
export function renderTemplateLaunchPrompt(input: {
  templatePrompt: string;
  callerPrompt?: string;
  args?: Record<string, string>;
}): RenderedTemplatePrompt {
  const parsed = parseTemplateArgs(input.templatePrompt);
  const args: Record<string, string> = { ...(input.args ?? {}) };
  const hasValue = (arg: (typeof parsed)[number]): boolean =>
    args[arg.key] != null || args[arg.name] != null;

  const callerPrompt = input.callerPrompt?.trim() ?? "";
  const missing = parsed.filter((arg) => !hasValue(arg));

  let filledFromPrompt: string | null = null;
  let leftover = callerPrompt;
  if (callerPrompt && missing.length === 1) {
    args[missing[0].key] = callerPrompt;
    filledFromPrompt = missing[0].name;
    leftover = "";
  }

  const unfilled = parsed.filter((arg) => !hasValue(arg));
  // substituteArgs throws on missing required args; an explicit empty value
  // keeps a partially-specified launch working instead of failing outright.
  for (const arg of unfilled) args[arg.key] = "";

  let prompt =
    parsed.length > 0
      ? substituteArgs(input.templatePrompt, args)
      : input.templatePrompt;

  if (leftover) {
    prompt = `${prompt.trimEnd()}\n\n${APPENDED_PROMPT_HEADING}\n\n${leftover}`;
  }

  return {
    prompt,
    filledFromPrompt,
    unfilled: unfilled.map((arg) => arg.name),
    appendedCallerPrompt: leftover.length > 0,
  };
}
