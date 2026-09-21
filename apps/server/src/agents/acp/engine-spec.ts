import type { AgentType } from "@dispatch/shared";

import { selfCommand } from "./runtime.js";

/** The engines the ACP runtime can drive. `agents.type` names one of these. */
export const ACP_ENGINE_IDS = ["claude", "codex"] as const;
export type AcpEngineId = (typeof ACP_ENGINE_IDS)[number];

export function isAcpEngine(type: AgentType | string): type is AcpEngineId {
  return (ACP_ENGINE_IDS as readonly string[]).includes(type);
}

export type EngineBins = {
  /** Absolute path to the host's `claude`, for `CLAUDE_CODE_EXECUTABLE`. */
  claudeBin: string;
  /** Absolute path to the host's `codex`, for `CODEX_PATH`. */
  codexBin: string | null;
  /**
   * Runs the adapter instead of this binary's own mode. Only the tests set
   * it, to stand a fake engine in place of a real one; production always
   * re-execs Dispatch.
   */
  adapter?: { bin: string; args?: string[] };
};

/**
 * The adapters are modes of this binary (see main.ts), so an engine is
 * spawned by re-execing Dispatch rather than by finding a globally
 * installed `claude-agent-acp` / `codex-acp` on PATH. Nothing to install,
 * and the adapter is always the version this build was tested against.
 */
export function adapterCommand(
  engine: AcpEngineId,
  bins: EngineBins
): { bin: string; args: string[] } {
  if (bins.adapter) {
    return { bin: bins.adapter.bin, args: bins.adapter.args ?? [] };
  }
  // Test seam, the same shape as DISPATCH_AGENT_HOST_COMMAND: a JSON array
  // standing a fake engine in for the real one, so e2e can drive the whole
  // runtime without an engine installed. Not a supported setting.
  const override = process.env.DISPATCH_ACP_ADAPTER_COMMAND;
  if (override) {
    try {
      const parsed: unknown = JSON.parse(override);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((part) => typeof part === "string")
      ) {
        const [bin, ...args] = parsed as string[];
        return { bin: bin!, args };
      }
    } catch {
      // A malformed override runs the real adapter rather than nothing.
    }
  }
  const [bin, ...args] = selfCommand(`${engine}-acp`);
  return { bin: bin!, args };
}


export type FullAccess =
  /** Already in `args`. */
  | { kind: "args" }
  /** Already in `env`. */
  | { kind: "env" }
  /** The agent asks per call; the driver's requestPermission handler allows. */
  | { kind: "permission_request" };

export type EngineSpec = {
  id: AcpEngineId;
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /**
   * `system_prompt`: `session/new` and `session/resume` carry
   * `_meta.systemPrompt.append`. `first_prompt`: the guidance is the leading
   * block of a fresh session's first prompt.
   */
  personaDelivery: "system_prompt" | "first_prompt";
  fullAccess: FullAccess;
  /** Declare `_meta["subagent-transcript"]` at initialize and nest by parentToolUseId. */
  subagentTranscripts: boolean;
};

export function engineSpecFor(engine: AcpEngineId, bins: EngineBins): EngineSpec {
  switch (engine) {
    case "claude":
      return {
        id: engine,
        bin: adapterCommand(engine, bins).bin,
        args: [
          ...adapterCommand(engine, bins).args,
          "--dangerously-skip-permissions",
        ],
        env: { CLAUDE_CODE_EXECUTABLE: bins.claudeBin },
        personaDelivery: "system_prompt",
        fullAccess: { kind: "args" },
        subagentTranscripts: true,
      };
    case "codex":
      return {
        id: engine,
        bin: adapterCommand(engine, bins).bin,
        args: adapterCommand(engine, bins).args,
        env: {
          INITIAL_AGENT_MODE: "agent-full-access",
          NO_BROWSER: "1",
          ...(bins.codexBin ? { CODEX_PATH: bins.codexBin } : {}),
        },
        personaDelivery: "first_prompt",
        fullAccess: { kind: "env" },
        subagentTranscripts: false,
      };
  }
}
