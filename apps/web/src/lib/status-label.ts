/**
 * The words for a wire enum: `timed_out` reads "Timed out". An enum that needs
 * different wording (`degraded` is "Needs attention") says so at its own map.
 */
export function statusLabel(value: string): string {
  const words = value.replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
