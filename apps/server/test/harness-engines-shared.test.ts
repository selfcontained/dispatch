import { describe, expect, it } from "vitest";
import {
  DEFAULT_HARNESS_MODEL,
  HARNESS_ENGINES,
  harnessEngineOf,
} from "@dispatch/shared";

describe("HARNESS_ENGINES", () => {
  it("lists the four engines in create-dialog order", () => {
    expect(HARNESS_ENGINES.map((e) => e.id)).toEqual([
      "claude",
      "codex",
      "gemini",
      "opencode",
    ]);
  });

  it("knows which engines publish a plan, a model option, usage, and cost", () => {
    const by = Object.fromEntries(HARNESS_ENGINES.map((e) => [e.id, e]));
    expect(by.claude).toMatchObject({
      publishesPlan: true,
      publishesModelOption: true,
      reportsUsage: true,
      reportsCost: true,
    });
    expect(by.codex).toMatchObject({
      publishesPlan: true,
      publishesModelOption: true,
      reportsUsage: true,
      reportsCost: false,
    });
    expect(by.gemini).toMatchObject({
      publishesPlan: false,
      publishesModelOption: false,
      reportsUsage: false,
      reportsCost: false,
    });
    expect(by.opencode).toMatchObject({
      publishesPlan: false,
      publishesModelOption: true,
      reportsUsage: true,
      reportsCost: true,
    });
  });

  it("resolves an engine from a model id prefix", () => {
    expect(harnessEngineOf("codex/gpt-5.6-sol")?.id).toBe("codex");
    expect(harnessEngineOf("opencode/anthropic/claude-sonnet-5")?.id).toBe(
      "opencode"
    );
    expect(harnessEngineOf(DEFAULT_HARNESS_MODEL)?.id).toBe("claude");
    expect(harnessEngineOf("gpt-5.6-sol")).toBeNull();
    expect(harnessEngineOf("deepseek/x")).toBeNull();
    expect(harnessEngineOf(null)).toBeNull();
  });
});
