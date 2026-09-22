// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { engineSummary, type EngineStatus } from "./use-engines";

const codex: EngineStatus = {
  id: "codex",
  label: "Codex",
  installed: true,
  path: "/opt/homebrew/bin/codex",
  version: "0.155.1",
  install: "npm i -g @openai/codex",
};

describe("engineSummary", () => {
  it("names the binary and release the picker's models come from", () => {
    expect(engineSummary([codex], "codex")).toBe(
      "Codex 0.155.1 · /opt/homebrew/bin/codex"
    );
  });

  it("leaves the version out when the CLI did not say, and says nothing for a missing engine", () => {
    expect(engineSummary([{ ...codex, version: null }], "codex")).toBe(
      "Codex · /opt/homebrew/bin/codex"
    );
    expect(
      engineSummary([{ ...codex, installed: false, path: null }], "codex")
    ).toBeNull();
    expect(engineSummary([codex], "claude")).toBeNull();
  });
});
