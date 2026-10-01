import path from "node:path";
import { localAgentCaBundle } from "../../local-tls.js";
import type { HostLaunch } from "./host-protocol.js";

/** Called in the host, after the login shell and ~/.dispatch/env are loaded. */
export function buildHostEnv(
  launch: Pick<HostLaunch, "env" | "engine" | "pathPrefix">,
  stateDir: string,
  shellEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env = { ...shellEnv, ...launch.env };
  const ca = launch.env.DISPATCH_LOCAL_CA_CERTIFICATE;
  delete env.DISPATCH_LOCAL_CA_CERTIFICATE;
  if (ca) {
    // Each host and consumer owns its bundle: corporate roots for one agent
    // or tool must never replace another agent's or tool's trust configuration.
    env.NODE_EXTRA_CA_CERTS = localAgentCaBundle(
      ca,
      env.NODE_EXTRA_CA_CERTS,
      path.join(stateDir, "node-ca.pem")
    );
    if (launch.engine === "codex") {
      env.CODEX_CA_CERTIFICATE = localAgentCaBundle(
        ca,
        env.CODEX_CA_CERTIFICATE || env.SSL_CERT_FILE,
        path.join(stateDir, "codex-ca.pem")
      );
    }
    env.CURL_CA_BUNDLE = localAgentCaBundle(
      ca,
      env.CURL_CA_BUNDLE || env.SSL_CERT_FILE,
      path.join(stateDir, "curl-ca.pem")
    );
  }
  env.PATH = Array.from(
    new Set([
      ...launch.pathPrefix,
      ...(shellEnv.PATH ?? "").split(path.delimiter),
    ])
  )
    .filter(Boolean)
    .join(path.delimiter);
  return env;
}
