// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit) —
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
/**
 * Formats a {@link Step.durMs}-shaped duration for compact inline display:
 * whole milliseconds under one second, otherwise seconds to one decimal
 * place.
 *
 * @example
 * ```ts
 * formatStepDuration(920);  // '920ms'
 * formatStepDuration(7200); // '7.2s'
 * ```
 */
export function formatStepDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
