import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { rootCertificates } from "node:tls";
import { withToolSearchPath } from "../../shared/lib/tool-environment.js";
import { withEngineBinDir } from "./engine-bin-dir.js";
import type { AcpEngineId, EngineBins } from "./engine-spec.js";
import { hostFile, type HostLaunch } from "./host-protocol.js";

/** Called in the host, after the login shell and ~/.dispatch/env are loaded. */
export function buildHostEnv(
  launch: Pick<HostLaunch, "env" | "engine" | "pathPrefix"> &
    Partial<Pick<HostLaunch, "bins" | "effort">>,
  stateDir: string,
  shellEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env = { ...shellEnv, ...launch.env };
  delete env.DISPATCH_ACP_ADAPTER_COMMAND;
  if (launch.effort != null) {
    delete env.CLAUDE_EFFORT;
    delete env.CLAUDE_CODE_EFFORT_LEVEL;
  }
  const ca = launch.env.DISPATCH_LOCAL_CA_CERTIFICATE;
  delete env.DISPATCH_LOCAL_CA_CERTIFICATE;
  if (ca) {
    // Each host and consumer owns its bundle: corporate roots for one agent
    // or tool must never replace another agent's or tool's trust configuration.
    env.NODE_EXTRA_CA_CERTS = localAgentCaBundle(
      ca,
      env.NODE_EXTRA_CA_CERTS || env.SSL_CERT_FILE,
      hostFile(stateDir, "nodeCa")
    );
    if (launch.engine === "codex") {
      env.CODEX_CA_CERTIFICATE = localAgentCaBundle(
        ca,
        env.CODEX_CA_CERTIFICATE || env.SSL_CERT_FILE,
        hostFile(stateDir, "codexCa")
      );
    }
    env.CURL_CA_BUNDLE = localAgentCaBundle(
      ca,
      env.CURL_CA_BUNDLE || env.SSL_CERT_FILE,
      hostFile(stateDir, "curlCa")
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

function atomicWrite(file: string, data: string) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * A trust bundle for one consumer: the public roots, an existing custom
 * bundle, then the caller's CA. The caller names the CA by its file.
 */
export function localAgentCaBundle(
  caPath: string,
  existingBundle: string | undefined,
  output: string
): string {
  const certificates = [...rootCertificates];
  if (existingBundle) certificates.push(readFileSync(existingBundle, "utf8"));
  certificates.push(readFileSync(caPath, "utf8"));
  atomicWrite(output, certificates.join("\n"));
  return output;
}
