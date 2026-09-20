import path from "node:path";

import { createReleaseUpdateToken } from "../../auth.js";
import type { AppConfig } from "../../config.js";
import type { AgentRole } from "../types.js";
import type { AcpEngineId } from "./engine-spec.js";

/**
 * The environment additions the engine child gets, and the PATH entries
 * put ahead of the host's own: one shape for the plugin skills and hooks
 * the agent's shell runs.
 */
export function buildLaunchEnv(input: {
  agentId: string;
  role: AgentRole;
  filesDir: string;
  engine: AcpEngineId;
  config: Pick<AppConfig, "port" | "tls" | "dispatchBinDir" | "authToken">;
  base?: NodeJS.ProcessEnv;
}): { env: Record<string, string>; pathPrefix: string[] } {
  const base = input.base ?? process.env;
  const scheme = input.config.tls ? "https" : "http";
  const env: Record<string, string> = {
    DISPATCH_AGENT_ID: input.agentId,
    DISPATCH_FILES_DIR: input.filesDir,
    DISPATCH_PORT: String(input.config.port),
    DISPATCH_SCHEME: scheme,
  };
  // The assisted-update agent drives the release API directly; its prompt
  // tells it to curl with these.
  if (input.role === "assisted_update") {
    env.DISPATCH_API_URL = `${scheme}://127.0.0.1:${input.config.port}`;
    env.DISPATCH_RELEASE_UPDATE_TOKEN = createReleaseUpdateToken(
      input.config.authToken,
      input.agentId
    );
  }
  // Under TLS the MCP URL is loopback https; the child needs the CA or
  // every Dispatch tool call fails verification.
  if (input.config.tls && base.TLS_CA) {
    env.NODE_EXTRA_CA_CERTS = base.TLS_CA;
  }
  // Pin the Bash tool's cwd to the project root after every command so it
  // does not drift back to the original repo root over a long conversation.
  if (input.engine === "claude") {
    env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR = "1";
  }
  const localBin = base.HOME ? path.join(base.HOME, ".local/bin") : null;
  const pathPrefix = [input.config.dispatchBinDir, localBin].filter(
    (entry): entry is string => Boolean(entry)
  );
  return { env, pathPrefix };
}
