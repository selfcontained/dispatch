import { formatShortDate } from "@/lib/format";
import type { ActivityGranularity } from "@/hooks/use-activity";

export function formatDate(iso: string): string {
  return formatShortDate(iso);
}

export function formatBucketLabel(
  iso: string,
  granularity: ActivityGranularity
): string {
  if (granularity === "hour") {
    // iso is like "2026-04-14 09:00"
    const hourStr = iso.split(" ")[1] ?? "00:00";
    const hour = parseInt(hourStr.split(":")[0], 10);
    const suffix = hour >= 12 ? "pm" : "am";
    const normalized = hour % 12 === 0 ? 12 : hour % 12;
    return `${normalized}${suffix}`;
  }
  const d = new Date(iso + "T00:00:00");
  if (granularity === "month") {
    return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  }
  if (granularity === "week") {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return formatDate(iso);
}

export function msToMinutes(ms: number): number {
  return Math.round(ms / 60_000);
}

export function shortModelName(model: string): string {
  if (model.includes("opus")) return "Opus";
  if (model.includes("sonnet")) return "Sonnet";
  if (model.includes("haiku")) return "Haiku";
  if (model.includes("gpt-5")) return "GPT-5";
  if (model.includes("gpt-4")) return "GPT-4";
  return model;
}

// ── Gap filling ─────────────────────────────────────────────────────

export function fillGaps<T extends { day: string }>(
  data: T[],
  granularity: ActivityGranularity,
  defaultEntry: (day: string) => T,
  dailyDate?: string
): T[] {
  if (granularity === "hour") {
    // Fill all 24 hours for the selected day
    const dataMap = new Map(data.map((d) => [d.day, d]));
    const datePrefix =
      dailyDate ??
      (data.length > 0
        ? data[0].day.split(" ")[0]
        : new Date().toISOString().slice(0, 10));
    const filled: T[] = [];
    for (let h = 0; h < 24; h++) {
      const key = `${datePrefix} ${String(h).padStart(2, "0")}:00`;
      filled.push(dataMap.get(key) ?? defaultEntry(key));
    }
    return filled;
  }
  if (granularity !== "day") return data;
  if (data.length < 2) return data;
  const filled: T[] = [];
  const dataMap = new Map(data.map((d) => [d.day, d]));
  const start = new Date(data[0].day + "T00:00:00");
  const end = new Date(data[data.length - 1].day + "T00:00:00");
  const cursor = new Date(start);
  while (cursor <= end) {
    const iso = cursor.toISOString().slice(0, 10);
    filled.push(dataMap.get(iso) ?? defaultEntry(iso));
    cursor.setDate(cursor.getDate() + 1);
  }
  return filled;
}
