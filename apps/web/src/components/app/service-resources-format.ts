import type { ResourceHealthState } from "@/hooks/use-service-resources";

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

export function formatMs(value: number | null): string {
  if (value === null) return "—";
  if (value < 1) return "<1 ms";
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function stateLabel(state: ResourceHealthState): string {
  if (state === "degraded") return "Needs attention";
  return state.replace("_", " ");
}

export function stateBadgeVariant(state: ResourceHealthState) {
  if (state === "healthy" || state === "running") return "running" as const;
  if (state === "degraded" || state === "unavailable") return "error" as const;
  if (state === "unknown") return "stopped" as const;
  return "default" as const;
}

export function metadataLabel(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}
