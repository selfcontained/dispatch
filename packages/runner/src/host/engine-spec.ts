import path from "node:path";

import { selfCommand } from "./host-command.js";

import type { AcpEngineId, EngineBins } from "@dispatch/runner-protocol/host";
export { ACP_ENGINE_IDS, isAcpEngine } from "@dispatch/runner-protocol/host";
export type { AcpEngineId, EngineBins } from "@dispatch/runner-protocol/host";

/**
 * Claude and Codex adapters are modes of this binary (see main.ts), so each is
 * spawned by re-execing Dispatch rather than by finding a globally
 * installed `claude-agent-acp` / `codex-acp` on PATH. Nothing to install,
 * and the adapter is always the version this build was tested against.
 * OpenCode instead ships ACP in its own CLI (`opencode acp`).
 */
export function adapterCommand(
  engine: AcpEngineId,
  bins: EngineBins
): { bin: string; args: string[] } {
  if (bins.adapter) {
    return { bin: bins.adapter.bin, args: bins.adapter.args ?? [] };
  }
  if (engine === "opencode")
    return { bin: engineBin(engine, bins), args: ["acp"] };
  const [bin, ...args] = selfCommand(`${engine}-acp`);
  return { bin: bin!, args };
}

export type FullAccess =
  | { kind: "approval" }
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
   * Lower-precedence than `env` and than the launch's own env: the driver
   * object-spreads this first, so any own key the launch env already
   * carries overrides it — any string value including `"0"`/`"false"`/`""`,
   * and even an explicit `undefined` (spread copies key presence, not just
   * truthiness).
   */
  envDefaults?: NodeJS.ProcessEnv;
  /**
   * `system_prompt`: `session/new` and `session/resume` carry
   * `_meta.systemPrompt.append`. `first_prompt`: the guidance is the leading
   * block of the first non-command prompt after launch or resume (without
   * opening a turn). Raw slash commands leave the guidance pending.
   * `instructions_file`: the host adds a private file to OpenCode config.
   */
  guidanceDelivery: "system_prompt" | "first_prompt" | "instructions_file";
  fullAccess: FullAccess;
  /** Declare `_meta["subagent-transcript"]` at initialize and nest by parentToolUseId. */
  subagentTranscripts: boolean;
};

/**
 * The launched engine's CLI as an absolute path, or an error saying so.
 * Each adapter falls back to a CLI of its own when its env var is unset —
 * codex-acp to the @openai/codex it depends on, which from a source run is
 * the repo's copy and months stale. A launch that fails with "could not
 * find codex" beats one that quietly runs a CLI nobody chose. A fake
 * adapter (tests) drives no CLI, so it needs none.
 */
function engineBin(engine: AcpEngineId, bins: EngineBins): string {
  const bin =
    engine === "claude"
      ? bins.claudeBin
      : engine === "codex"
        ? bins.codexBin
        : bins.opencodeBin;
  if (bins.adapter) return bin ?? "";
  if (!bin || !path.isAbsolute(bin)) {
    const name = engine;
    throw new Error(
      `Could not find the ${name} CLI${bin ? ` (got "${bin}")` : ""}. Install it, or set DISPATCH_${name.toUpperCase()}_BIN to its absolute path.`
    );
  }
  return bin;
}

export function engineSpecFor(
  engine: AcpEngineId,
  bins: EngineBins,
  fullAccess = true
): EngineSpec {
  const bin = engineBin(engine, bins);
  switch (engine) {
    case "opencode":
      return {
        id: engine,
        ...adapterCommand(engine, bins),
        // V2 supports full access only; native effective denies still apply.
        env: {},
        guidanceDelivery: "instructions_file",
        fullAccess: { kind: "permission_request" },
        subagentTranscripts: false,
      };
    case "claude":
      return {
        id: engine,
        bin: adapterCommand(engine, bins).bin,
        args: [
          ...adapterCommand(engine, bins).args,
          ...(fullAccess ? ["--dangerously-skip-permissions"] : []),
        ],
        env: { CLAUDE_CODE_EXECUTABLE: bin },
        // Undocumented opt-in: the installed CLI gates its headless Artifact
        // tools on this var regardless of `--settings enableArtifact`, so we
        // default it on for every Claude launch. See
        // https://github.com/anthropics/claude-code/issues/80606.
        envDefaults: { CLAUDE_CODE_ARTIFACT: "1" },
        guidanceDelivery: "system_prompt",
        fullAccess: { kind: fullAccess ? "args" : "approval" },
        subagentTranscripts: true,
      };
    case "codex":
      return {
        id: engine,
        bin: adapterCommand(engine, bins).bin,
        args: adapterCommand(engine, bins).args,
        env: {
          // The adapter calls its user-reviewed workspace-write preset "read-only".
          INITIAL_AGENT_MODE: fullAccess ? "agent-full-access" : "read-only",
          NO_BROWSER: "1",
          CODEX_PATH: bin,
        },
        guidanceDelivery: "first_prompt",
        fullAccess: { kind: fullAccess ? "env" : "approval" },
        subagentTranscripts: false,
      };
  }
}
