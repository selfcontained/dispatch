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

export function buildSafariDeviceName(
  platform: string,
  userAgent: string,
  maxTouchPoints: number,
  suffix: string
): string {
  let label: string;
  if (platform === "ios") {
    // Desktop-mode iPad UAs say "Macintosh" but still report touch points.
    const isIpad =
      userAgent.includes("iPad") ||
      (userAgent.includes("Macintosh") && maxTouchPoints > 1);
    label = isIpad ? "iPadOS" : "iOS";
  } else if (platform === "mac") {
    label = "macOS";
  } else {
    label = PLATFORM_LABELS[platform] ?? "this device";
  }
  return `Safari on ${label} · ${suffix.toUpperCase()}`;
}
