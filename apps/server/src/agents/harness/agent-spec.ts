import { HARNESS_ENGINE_IDS, type HarnessEngineId } from "@dispatch/shared";

/**
 * One row per engine the harness can run: what to spawn, how it gets full
 * access, how the persona reaches it, and what it negotiates. The
 * supervisor picks a row from the agent's model id; the driver spawns what
 * the row says and knows nothing else about the engine.
 */

export type EngineBins = {
  claudeHarnessBin: string;
  codexHarnessBin: string;
  geminiBin: string;
  opencodeBin: string;
  /** Absolute path to the host's `claude`, for `CLAUDE_CODE_EXECUTABLE`. */
  claudeBin: string;
  /** Absolute path to the host's `codex`, or null to run the adapter's bundled one. */
  codexBin: string | null;
};

export type FullAccess =
  /** Already in `args`. */
  | { kind: "args" }
  /** Already in `env`. */
  | { kind: "env" }
  /** `session/set_mode` to this mode id right after the session opens. */
  | { kind: "set_mode"; modeId: string }
  /** The agent asks per call; the driver's requestPermission handler allows. */
  | { kind: "permission_request" };

export type EngineSpec = {
  id: HarnessEngineId;
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /**
   * `system_prompt`: `session/new` and `session/resume` carry
   * `_meta.systemPrompt.append`. `first_prompt`: the persona is the leading
   * block of a fresh session's first prompt.
   */
  personaDelivery: "system_prompt" | "first_prompt";
  fullAccess: FullAccess;
  /** Declare `_meta["subagent-transcript"]` at initialize and nest by parentToolUseId. */
  subagentTranscripts: boolean;
  /** The model is a launch flag, so `/model` cannot switch it. */
  modelFixedAtLaunch: boolean;
};

const ENGINE_IDS: readonly string[] = HARNESS_ENGINE_IDS;

/** `engine/model` at the first slash; the model half may itself contain slashes. */
export function splitModelId(model: string): {
  engine: HarnessEngineId;
  model: string;
} {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(`harness model ids are engine/model; got "${model}"`);
  }
  const engine = model.slice(0, slash);
  if (!ENGINE_IDS.includes(engine)) {
    throw new Error(`unknown engine "${engine}" in model id "${model}"`);
  }
  return { engine: engine as HarnessEngineId, model: model.slice(slash + 1) };
}

export function engineSpecFor(
  engine: HarnessEngineId,
  model: string,
  bins: EngineBins
): EngineSpec {
  switch (engine) {
    case "claude":
      return {
        id: engine,
        bin: bins.claudeHarnessBin,
        args: ["--dangerously-skip-permissions"],
        env: { CLAUDE_CODE_EXECUTABLE: bins.claudeBin },
        personaDelivery: "system_prompt",
        fullAccess: { kind: "args" },
        subagentTranscripts: true,
        modelFixedAtLaunch: false,
      };
    case "codex":
      return {
        id: engine,
        bin: bins.codexHarnessBin,
        args: [],
        env: {
          INITIAL_AGENT_MODE: "agent-full-access",
          NO_BROWSER: "1",
          ...(bins.codexBin ? { CODEX_PATH: bins.codexBin } : {}),
        },
        personaDelivery: "first_prompt",
        fullAccess: { kind: "env" },
        subagentTranscripts: false,
        modelFixedAtLaunch: false,
      };
    case "gemini":
      return {
        id: engine,
        bin: bins.geminiBin,
        args: [
          "--experimental-acp",
          ...(model !== "default" ? ["--model", model] : []),
        ],
        env: {},
        personaDelivery: "first_prompt",
        fullAccess: { kind: "set_mode", modeId: "yolo" },
        subagentTranscripts: false,
        modelFixedAtLaunch: true,
      };
    case "opencode":
      return {
        id: engine,
        bin: bins.opencodeBin,
        args: ["acp"],
        env: {},
        personaDelivery: "first_prompt",
        fullAccess: { kind: "permission_request" },
        subagentTranscripts: false,
        modelFixedAtLaunch: false,
      };
  }
}
