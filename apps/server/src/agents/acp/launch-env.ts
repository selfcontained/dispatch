import { serverOrigin } from "../../server-origin.js";
import type { AppConfig } from "../../config.js";

/** Listener metadata the controller gives its local runner at startup. */
export function launchListenerEnv(
  config: Pick<AppConfig, "port" | "tls" | "listenHosts">,
  base: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = {
    DISPATCH_PORT: String(config.port),
    DISPATCH_SCHEME: config.tls ? "https" : "http",
  };
  if (config.listenHosts) {
    env.DISPATCH_API_URL = serverOrigin(config);
    env.DISPATCH_API_BASE = env.DISPATCH_API_URL;
  }
  if (config.tls && base.TLS_CA) {
    if (base.DISPATCH_LOCAL_TLS === "1")
      env.DISPATCH_LOCAL_CA_CERTIFICATE = base.TLS_CA;
    else env.NODE_EXTRA_CA_CERTS = base.TLS_CA;
  }
  return env;
}

/** The local installation's configured values, before runner discovery. */
export function localLaunchSettings(
  config: Pick<
    AppConfig,
    | "filesRoot"
    | "dispatchBinDir"
    | "port"
    | "tls"
    | "listenHosts"
    | "claudeBin"
    | "codexBin"
    | "opencodeBin"
    | "acpAdapter"
  >
) {
  return {
    filesRoot: config.filesRoot,
    helperBin: config.dispatchBinDir,
    env: launchListenerEnv(config),
    bins: {
      claudeBin: config.claudeBin,
      codexBin: config.codexBin,
      opencodeBin: config.opencodeBin,
      adapter: config.acpAdapter,
    },
  };
}
