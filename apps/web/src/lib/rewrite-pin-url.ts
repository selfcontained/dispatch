const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
]);

export function extractHostname(targetHost: string): string {
  try {
    return new URL(`http://${targetHost}`).hostname;
  } catch {
    return targetHost;
  }
}

/**
 * If `value` parses as a URL with a loopback host, swap in the hostname from
 * `targetHost` (typically `window.location.host`). The URL's original port,
 * path, query, and fragment are preserved. Non-loopback or unparseable inputs
 * pass through unchanged.
 */
export function rewritePinUrl(value: string, targetHost: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) return value;
  url.hostname = extractHostname(targetHost);
  return url.toString();
}
