import type { AgentConfigChoice, Effort } from "@dispatch/shared";

export function effortCompatibilityError(
  effort: Effort | null | undefined,
  choices: readonly AgentConfigChoice[] | undefined
): string | null {
  if (
    effort == null ||
    choices === undefined ||
    choices.some((choice) => choice.value === effort)
  )
    return null;
  return `The saved effort "${effort}" is not available for this model. Choose an available level or change the template.`;
}
