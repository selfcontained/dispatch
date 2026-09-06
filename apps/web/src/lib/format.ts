export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "n/a";
  if (ms < 1000) return "0s";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function shortProjectName(project: string): string {
  const parts = project.replace(/\/$/, "").split("/").filter(Boolean);
  return parts.length <= 2 ? project : parts.slice(-2).join("/");
}

export function shortPath(value: string): string {
  const parts = value.split("/").filter(Boolean);
  if (parts.length <= 3) return value;
  return `.../${parts.slice(-3).join("/")}`;
}

/**
 * Constructing an `Intl.DateTimeFormat` does a locale-data lookup, which
 * shows up once a formatter is called per row of a long list. Formatters are
 * keyed by their options and kept for the page's lifetime; the locale is the
 * browser default throughout, as it was when each call built its own.
 */
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();
function dateTimeFormatter(
  options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let formatter = dateTimeFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, options);
    dateTimeFormatters.set(key, formatter);
  }
  return formatter;
}

/**
 * `Intl.DateTimeFormat.format` throws on an invalid date where the
 * `toLocale*String` methods return "Invalid Date"; keep the latter, since
 * callers pass server strings that are not always dates (a draft release has
 * no publish time, for one).
 */
function formatDate(date: Date, options: Intl.DateTimeFormatOptions): string {
  if (!Number.isFinite(date.getTime())) return "Invalid Date";
  return dateTimeFormatter(options).format(date);
}

export function formatDateTime(iso: string): string {
  return formatDate(new Date(iso), {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatShortDateTime(iso: string): string {
  return formatDate(new Date(iso), {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatShortDate(dateOnlyIso: string): string {
  return formatDate(new Date(dateOnlyIso + "T00:00:00"), {
    month: "short",
    day: "numeric",
  });
}

export function formatRelativeTime(iso: string): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(new Date(iso), { month: "short", day: "numeric" });
}

/** Badge counts stop at "99+" so a runaway number can't stretch the chip. */
export function formatBadgeCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}
