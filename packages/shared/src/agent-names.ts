/** A readable initial session name for a task, limited by Unicode code points. */
export function taskAgentName(title: string): string {
  const normalized = title.replace(/\s+/gu, " ").trim();
  const points = Array.from(normalized);
  if (points.length <= 40) return normalized;
  const prefix = points.slice(0, 40).join("");
  // A space immediately after the prefix means the whole prefix fits.
  const boundary = points[40] === " " ? prefix.length : prefix.lastIndexOf(" ");
  return (boundary > 0 ? prefix.slice(0, boundary) : prefix).trimEnd() + "…";
}
