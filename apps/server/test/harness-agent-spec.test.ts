import { describe, expect, it } from "vitest";

import {
  engineSpecFor,
  splitModelId,
  type EngineBins,
} from "../src/agents/harness/agent-spec.js";

const bins: EngineBins = {
  claudeHarnessBin: "/usr/local/bin/claude-agent-acp",
  codexHarnessBin: "/usr/local/bin/codex-acp",
  geminiBin: "/usr/local/bin/gemini",
  opencodeBin: "/usr/local/bin/opencode",
  claudeBin: "/home/u/.local/bin/claude",
  codexBin: null,
};

describe("splitModelId", () => {
  it("splits at the first slash so OpenCode's provider/model survives", () => {
    expect(splitModelId("claude/default")).toEqual({
      engine: "claude",
      model: "default",
    });
    expect(splitModelId("opencode/anthropic/claude-sonnet-5")).toEqual({
      engine: "opencode",
      model: "anthropic/claude-sonnet-5",
    });
  });

  it("rejects ids without an engine or with an unknown one", () => {
    expect(() => splitModelId("gpt-5.6-sol")).toThrow(/engine\/model/);
    expect(() => splitModelId("nope/v4")).toThrow(/unknown engine/);
    expect(() => splitModelId("claude/")).toThrow(/engine\/model/);
  });
});

describe("engineSpecFor", () => {
  it("claude: the adapter, skip-permissions, the host claude, system-prompt persona, nested subagents", () => {
    const spec = engineSpecFor("claude", "default", bins);
    expect(spec).toMatchObject({
      id: "claude",
      bin: "/usr/local/bin/claude-agent-acp",
      args: ["--dangerously-skip-permissions"],
      env: { CLAUDE_CODE_EXECUTABLE: "/home/u/.local/bin/claude" },
      personaDelivery: "system_prompt",
      fullAccess: { kind: "args" },
      subagentTranscripts: true,
      modelFixedAtLaunch: false,
    });
  });

  it("codex: full access by env, bundled codex unless a host codex is configured", () => {
    expect(engineSpecFor("codex", "gpt-5.6-sol", bins)).toMatchObject({
      bin: "/usr/local/bin/codex-acp",
      args: [],
      env: { INITIAL_AGENT_MODE: "agent-full-access", NO_BROWSER: "1" },
      personaDelivery: "first_prompt",
      fullAccess: { kind: "env" },
      subagentTranscripts: false,
    });
    expect(
      engineSpecFor("codex", "default", { ...bins, codexBin: "/bin/codex" }).env
    ).toMatchObject({ CODEX_PATH: "/bin/codex" });
    expect(engineSpecFor("codex", "default", bins).env).not.toHaveProperty(
      "CODEX_PATH"
    );
  });

  it("gemini: the acp flag, the model as a launch flag, yolo by set_mode", () => {
    expect(engineSpecFor("gemini", "gemini-3-pro-preview", bins)).toMatchObject(
      {
        bin: "/usr/local/bin/gemini",
        args: ["--experimental-acp", "--model", "gemini-3-pro-preview"],
        env: {},
        personaDelivery: "first_prompt",
        fullAccess: { kind: "set_mode", modeId: "yolo" },
        modelFixedAtLaunch: true,
      }
    );
    expect(engineSpecFor("gemini", "default", bins).args).toEqual([
      "--experimental-acp",
    ]);
  });

  it("opencode: the acp subcommand, permissions answered by the driver", () => {
    expect(engineSpecFor("opencode", "default", bins)).toMatchObject({
      bin: "/usr/local/bin/opencode",
      args: ["acp"],
      env: {},
      personaDelivery: "first_prompt",
      fullAccess: { kind: "permission_request" },
      subagentTranscripts: false,
      modelFixedAtLaunch: false,
    });
  });
});
