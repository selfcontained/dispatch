// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit):
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
/**
 * How long something took, for a line of a turn: "920ms" under a second,
 * "7.2s" past it, "2m 5s" past a minute, "1h 4m" past an hour. Past a
 * minute the clock units carry the meaning a reader wants, so the tenths
 * drop and the seconds round; a long turn reads as time rather than as a
 * number to divide.
 */
export function formatStepDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
}
