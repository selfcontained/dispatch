import { afterEach, describe, expect, it, vi } from "vitest";

import { engineSpecFor } from "../src/agents/acp/engine-spec.js";

afterEach(() => vi.unstubAllEnvs());

describe("engineSpecFor", () => {
  it("launches restricted engines without permission bypass", () => {
    const bins = { claudeBin: "/x/claude", codexBin: "/x/codex" };
    const claude = engineSpecFor("claude", bins, false);
    expect(claude.args).not.toContain("--dangerously-skip-permissions");
    expect(claude.fullAccess.kind).toBe("approval");
    expect(engineSpecFor("codex", bins, false).env.INITIAL_AGENT_MODE).toBe(
      "read-only"
    );
    expect(engineSpecFor("codex", bins, true).env.INITIAL_AGENT_MODE).toBe(
      "agent-full-access"
    );
  });
  it("always hands the adapter the launched engine's CLI as an absolute path", () => {
    vi.stubEnv("DISPATCH_ACP_ADAPTER_COMMAND", "");
    const bins = {
      claudeBin: "/home/u/.local/bin/claude",
      codexBin: "/opt/homebrew/bin/codex",
    };
    expect(engineSpecFor("codex", bins).env.CODEX_PATH).toBe(
      "/opt/homebrew/bin/codex"
    );
    expect(engineSpecFor("claude", bins).env.CLAUDE_CODE_EXECUTABLE).toBe(
      "/home/u/.local/bin/claude"
    );
  });

  it("refuses a launch whose CLI it could not find, rather than letting the adapter pick its own", () => {
    vi.stubEnv("DISPATCH_ACP_ADAPTER_COMMAND", "");
    // Unset, codex-acp falls back to the @openai/codex it depends on.
    expect(() =>
      engineSpecFor("codex", { claudeBin: "/x/claude", codexBin: null })
    ).toThrow(/Could not find the codex CLI/);
    // A bare name is a lookup nobody did; the adapter would do its own.
    expect(() =>
      engineSpecFor("codex", { claudeBin: "/x/claude", codexBin: "codex" })
    ).toThrow(/DISPATCH_CODEX_BIN/);
    expect(() =>
      engineSpecFor("claude", { claudeBin: "", codexBin: "/x/codex" })
    ).toThrow(/Could not find the claude CLI/);
  });

  it("needs no CLI for a fake adapter, which drives none", () => {
    vi.stubEnv("DISPATCH_ACP_ADAPTER_COMMAND", "");
    expect(() =>
      engineSpecFor("codex", {
        claudeBin: "claude",
        codexBin: null,
        adapter: { bin: "/fake" },
      })
    ).not.toThrow();
  });
});
