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

/** A duration short enough that milliseconds are the useful unit. */
export function formatLatency(ms: number | null): string {
  return ms === null ? "—" : `${Math.round(ms)} ms`;
}

const countFormatter = new Intl.NumberFormat();

/** "1,204", or "1 session" / "1,204 sessions" given the noun. */
export function formatCount(count: number, noun?: string): string {
  const value = countFormatter.format(count);
  if (!noun) return value;
  return `${value} ${count === 1 ? noun : `${noun}s`}`;
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

export function formatLongDate(dateOnlyIso: string): string {
  return formatDate(new Date(dateOnlyIso + "T00:00:00"), {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatShortDate(dateOnlyIso: string): string {
  return formatDate(new Date(dateOnlyIso + "T00:00:00"), {
    month: "short",
    day: "numeric",
  });
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** An age in its largest unit ("now", "9m", "3h", "2d"), for cards and rows. */
export function formatRelativeCompact(iso: string): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "";
  const mins = Math.max(0, Math.floor((Date.now() - time) / MINUTE_MS));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export function formatRelativeTime(iso: string): string {
  const age = formatRelativeCompact(iso);
  if (!age) return "";
  if (age === "now") return "just now";
  if (Date.now() - new Date(iso).getTime() < 30 * DAY_MS) return `${age} ago`;
  return formatDate(new Date(iso), { month: "short", day: "numeric" });
}

export function formatTimeUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms < 0) return "now";
  if (ms < MINUTE_MS) return "< 1m";
  if (ms < DAY_MS) return `in ${formatDuration(ms)}`;
  return `in ${Math.floor(ms / DAY_MS)}d`;
}

/** "Today at 9:22 PM", "Tomorrow at 7:00 AM", then the dated form. */
export function formatDayTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const time = { hour: "numeric", minute: "2-digit" } as const;
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (date.toDateString() === today.toDateString())
    return `Today at ${formatDate(date, time)}`;
  if (date.toDateString() === tomorrow.toDateString())
    return `Tomorrow at ${formatDate(date, time)}`;
  return formatDate(date, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...time,
  });
}

/** Badge counts stop at "99+" so a runaway number can't stretch the chip. */
export function formatBadgeCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}
