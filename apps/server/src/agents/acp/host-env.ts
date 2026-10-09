import path from "node:path";
import { localAgentCaBundle } from "../../local-tls.js";
import { withToolSearchPath } from "../../shared/lib/tool-environment.js";
import { withEngineBinDir } from "./engine-bin-dir.js";
import type { AcpEngineId, EngineBins } from "./engine-spec.js";
import type { HostLaunch } from "./host-protocol.js";

/** Called in the host, after the login shell and ~/.dispatch/env are loaded. */
export function buildHostEnv(
  launch: Pick<HostLaunch, "env" | "engine" | "pathPrefix"> &
    Partial<Pick<HostLaunch, "bins">>,
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
  env.PATH = withEngineBinDir(
    [...launch.pathPrefix, shellEnv.PATH ?? ""].join(path.delimiter),
    launch.bins && launchedBin(launch.engine, launch.bins)
  );
  return withToolSearchPath(env);
}

function launchedBin(engine: AcpEngineId, bins: EngineBins): string | null {
  if (engine === "claude") return bins.claudeBin;
  if (engine === "codex") return bins.codexBin;
  return bins.opencodeBin ?? null;
}
