const PLATFORM_LABELS: Record<string, string> = {
  mac: "macOS",
  win: "Windows",
  android: "Android",
  cros: "ChromeOS",
  linux: "Linux",
  openbsd: "OpenBSD",
};

export function buildDeviceName(platform: string, suffix: string): string {
  const label = PLATFORM_LABELS[platform] ?? "this device";
  return `Chrome on ${label} · ${suffix.toUpperCase()}`;
}
