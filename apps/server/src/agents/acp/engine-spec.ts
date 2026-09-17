import type { AgentType } from "@dispatch/shared";

/** The engines the ACP runtime can drive. `agents.type` names one of these. */
export const ACP_ENGINE_IDS = ["claude", "codex"] as const;
export type AcpEngineId = (typeof ACP_ENGINE_IDS)[number];

export function isAcpEngine(type: AgentType | string): type is AcpEngineId {
  return (ACP_ENGINE_IDS as readonly string[]).includes(type);
}

export type EngineBins = {
  /** The Claude engine's ACP adapter (`claude-agent-acp`). */
  claudeAdapterBin: string;
  /** Absolute path to the host's `claude`, for `CLAUDE_CODE_EXECUTABLE`. */
  claudeBin: string;
  /** The Codex engine's ACP adapter (`codex-acp`). */
  codexAdapterBin: string;
  /** Absolute path to the host's `codex`, or null to run the adapter's bundled one. */
  codexBin: string | null;
};

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
        bin: bins.claudeAdapterBin,
        args: ["--dangerously-skip-permissions"],
        env: { CLAUDE_CODE_EXECUTABLE: bins.claudeBin },
        personaDelivery: "system_prompt",
        fullAccess: { kind: "args" },
        subagentTranscripts: true,
      };
    case "codex":
      return {
        id: engine,
        bin: bins.codexAdapterBin,
        args: [],
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
