import type { AppConfig } from "./config.js";

export function serverOrigin(
  config: Pick<AppConfig, "port" | "tls" | "listenHosts">
): string {
  let host = config.listenHosts?.[0] ?? "127.0.0.1";
  if (host === "0.0.0.0") host = "127.0.0.1";
  if (host === "::") host = "::1";
  if (host.includes(":")) host = `[${host}]`;
  return `${config.tls ? "https" : "http"}://${host}:${config.port}`;
}
