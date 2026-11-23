import type { Req } from "@dispatch/runner-protocol/contract";
import { MAX_INLINE_FIRST_TEXT_BYTES } from "@dispatch/runner-protocol";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { rootCertificates } from "node:tls";
import type { AcpEngineId, EngineBins } from "./engine-spec.js";
import { hostFile, type HostLaunch } from "./host-protocol.js";
import type { HostSearchPath } from "./host/types.js";

/** Bind the common variables for an agent started by a configured runner. */
export function agentLaunchBindings(
  engine: AcpEngineId
): Req<"session.launch">["env"] {
  return {
    DISPATCH_AGENT_ID: { from: "session.id" },
    DISPATCH_FILES_DIR: { from: "session.filesDir" },
    ...(engine === "claude" && {
      CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "1",
    }),
  };
}

/** Runner-owned launch bindings, before the host loads the login shell. */
export function buildLaunchEnv(input: {
  agentId: string;
  filesDir: string;
  helperBin: string;
  env?: Req<"session.launch">["env"];
  mcpOrigin?: string;
  mcpCaFile?: string;
  home?: string;
}): Pick<HostLaunch, "env" | "pathPrefix"> {
  const bindings = {
    "session.id": input.agentId,
    "session.filesDir": input.filesDir,
    "mcp.origin": input.mcpOrigin,
    "mcp.caFile": input.mcpCaFile,
  };
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.env ?? {})) {
    const resolved = typeof value === "string" ? value : bindings[value.from];
    if (resolved !== undefined) env[name] = resolved;
  }
  const pathPrefix = input.helperBin ? [input.helperBin] : [];
  if (input.home) pathPrefix.push(path.join(input.home, ".local/bin"));
  return { env, pathPrefix };
}

/** Materialize oversized first text in the runner's private host directory. */
export async function prepareHostLaunch(
  dir: string,
  launch: Omit<HostLaunch, "env" | "pathPrefix">,
  environment: Omit<Parameters<typeof buildLaunchEnv>[0], "agentId">
): Promise<HostLaunch> {
  return {
    ...launch,
    ...buildLaunchEnv({
      ...environment,
      agentId: launch.agentId,
    }),
    personaContext: await preparePersonaContext(dir, launch.personaContext),
  };
}

export async function writeHostLaunch(
  dir: string,
  launch: HostLaunch,
  flag: "w" | "wx"
): Promise<void> {
  await writeFile(hostFile(dir, "launch"), JSON.stringify(launch, null, 2), {
    mode: 0o600,
    flag,
  });
}

/** Keep the snapshot in the private host directory so restarts can recover it. */
export async function preparePersonaContext(
  stateDir: string,
  context: string | null | undefined
): Promise<string | null> {
  if (!context) return null;
  if (Buffer.byteLength(context, "utf8") <= MAX_INLINE_FIRST_TEXT_BYTES)
    return context;
  const file = hostFile(stateDir, "personaContext");
  await writeFile(file, context, { mode: 0o600 });
  return `The complete persona instructions, ownership scope, and briefing exceed the inline message budget. Nothing has been trimmed. Before beginning the task, read the entire UTF-8 launch context file at ${JSON.stringify(file)}. If your file tool limits output, read it in chunks until you reach the end. If you cannot read it, report the problem to the launching agent instead of reviewing with incomplete instructions.`;
}

/** Called in the host, after the login shell and ~/.dispatch/env are loaded. */
export function buildHostEnv(
  launch: Pick<HostLaunch, "env" | "engine" | "pathPrefix"> &
    Partial<Pick<HostLaunch, "bins" | "effort">>,
  stateDir: string,
  searchPath: HostSearchPath,
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
  env.PATH = searchPath.withEngineBinDir(
    [...launch.pathPrefix, shellEnv.PATH ?? ""].join(path.delimiter),
    launch.bins && launchedBin(launch.engine, launch.bins)
  );
  return searchPath.withToolSearchPath(env);
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
