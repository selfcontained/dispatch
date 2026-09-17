import path from "node:path";

import type { AppConfig } from "../../config.js";
import type { AcpEngineId } from "./engine-spec.js";

/**
 * The environment additions the engine child gets, and the PATH entries
 * put ahead of the host's own. The same contract the tmux launch exported,
 * so plugin skills and hooks the agent's shell runs see one shape.
 */
export function buildLaunchEnv(input: {
  agentId: string;
  mediaDir: string;
  engine: AcpEngineId;
  config: Pick<AppConfig, "port" | "tls" | "dispatchBinDir">;
  base?: NodeJS.ProcessEnv;
}): { env: Record<string, string>; pathPrefix: string[] } {
  const base = input.base ?? process.env;
  const env: Record<string, string> = {
    DISPATCH_AGENT_ID: input.agentId,
    DISPATCH_MEDIA_DIR: input.mediaDir,
    DISPATCH_PORT: String(input.config.port),
    DISPATCH_SCHEME: input.config.tls ? "https" : "http",
  };
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
