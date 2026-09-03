/** Renderer-owned formatting for surface values. Agents supply meaning
 * (ISO timestamps, enum-ish tokens); the renderer owns how they read. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Relative under 7 days, compact absolute beyond, never seconds. */
export function formatSurfaceTime(
  iso: string,
  now: Date = new Date()
): { text: string; absolute: string } {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return { text: iso, absolute: iso };
  const absolute = parsed.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const delta = now.getTime() - parsed.getTime();
  if (delta < 0) {
    // Future instants (deadlines, scheduled work) read as absolutes.
    return { text: absolute, absolute };
  }
  if (delta < MINUTE) return { text: "just now", absolute };
  if (delta < HOUR)
    return { text: `${Math.floor(delta / MINUTE)}m ago`, absolute };
  if (delta < DAY)
    return { text: `${Math.floor(delta / HOUR)}h ago`, absolute };
  if (delta < 7 * DAY)
    return { text: `${Math.floor(delta / DAY)}d ago`, absolute };
  const sameYear = parsed.getFullYear() === now.getFullYear();
  return {
    text: parsed.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "numeric" }),
    }),
    absolute,
  };
}

const SNAKE_CASE = /^[A-Za-z][A-Za-z0-9]*(_[A-Za-z0-9]+)+$/;

/**
 * Humanizes machine tokens that leak into visible labels: separator-bearing
 * snake_case becomes sentence case ("IN_PROGRESS" → "In progress"). The
 * guard is deliberately narrow so real values pass through verbatim —
 * "v0.38.0-rc.2", "CI PASSING", anything with whitespace, and plain
 * all-caps words stay untouched: a bare capitalized token is just as likely
 * an acronym ("API", "AWS", "NASA") as an enum, and mangling an acronym is
 * worse than showing a shouty enum.
 */
export function humanizeLabel(value: string): string {
  if (/\s/.test(value)) return value;
  if (SNAKE_CASE.test(value)) {
    const words = value.split("_").join(" ").toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return value;
}
