/**
 * Human-readable byte-size formatting shared by the server (release
 * tarball download progress logs) and the web client (release download
 * progress labels) — web re-exports this across the workspace boundary
 * (see apps/web/src/components/app/release-utils.ts). Keep it
 * dependency-free: no node imports, no browser globals.
 *
 * `compact` drops the space and shortens units to a single letter
 * ("1.5M" instead of "1.5 MB") for terse log lines.
 */
export function formatBytes(
  bytes: number,
  options: { compact?: boolean } = {}
): string {
  const [gb, mb, kb, b] = options.compact
    ? ["G", "M", "K", "B"]
    : [" GB", " MB", " KB", " B"];
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}${gb}`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)}${mb}`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)}${kb}`;
  }
  return `${bytes}${b}`;
}
