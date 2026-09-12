import { describe, expect, it, vi } from "vitest";

import {
  loadHarnessAuthReport,
  parseClaudeAuth,
  parseCodexAuth,
  parseGeminiAuth,
} from "../src/agents/harness/auth-status.js";

describe("harness auth status", () => {
  it("distinguishes subscription seats from API keys", () => {
    expect(parseCodexAuth("Logged in using ChatGPT")).toMatchObject({
      kind: "subscription",
      label: "ChatGPT subscription",
    });
    expect(parseCodexAuth("Logged in using an API key")).toMatchObject({
      kind: "api_key",
      label: "OpenAI API key",
    });
    expect(
      parseClaudeAuth(
        JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          subscriptionType: "team",
        })
      )
    ).toMatchObject({
      kind: "subscription",
      label: "Claude team subscription",
    });
    expect(parseGeminiAuth("gemini-api-key")).toMatchObject({
      kind: "api_key",
      label: "Google API key",
    });
    expect(parseGeminiAuth("oauth-personal")).toMatchObject({
      kind: "oauth",
      label: "Google account",
    });
  });

  it("returns only sanitized labels from host probes", async () => {
    const runner = vi.fn(async (command: string) => ({
      exitCode: 0,
      stdout:
        command === "codex"
          ? "Logged in using ChatGPT"
          : command === "claude"
            ? JSON.stringify({ loggedIn: true, authMethod: "apiKey" })
            : "1 credential",
      stderr: "",
    }));
    const report = await loadHarnessAuthReport(
      {
        claude: "claude",
        codex: "codex",
        gemini: "gemini",
        opencode: "opencode",
      },
      {
        runner,
        read: async () =>
          JSON.stringify({
            security: { auth: { selectedType: "oauth-personal" } },
          }),
        homeDir: "/home/service",
        now: new Date("2026-09-11T00:00:00Z"),
      }
    );
    expect(report.checkedAt).toBe("2026-09-11T00:00:00.000Z");
    expect(
      report.engines.map(({ engineId, kind }) => ({ engineId, kind }))
    ).toEqual([
      { engineId: "claude", kind: "api_key" },
      { engineId: "codex", kind: "subscription" },
      { engineId: "gemini", kind: "oauth" },
      { engineId: "opencode", kind: "configured" },
    ]);
    expect(JSON.stringify(report)).not.toContain("credential");
  });

  it("hands the probes the harness PATH so a bare engine name resolves where the spawn does", async () => {
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    await loadHarnessAuthReport(
      {
        claude: "claude",
        codex: "codex",
        gemini: "gemini",
        opencode: "opencode",
      },
      {
        runner,
        read: async () => "{}",
        env: { PATH: "/srv/dispatch/bin:/home/service/.local/bin:/usr/bin" },
      }
    );
    for (const call of runner.mock.calls) {
      expect((call[2] as { env?: NodeJS.ProcessEnv }).env?.PATH).toBe(
        "/srv/dispatch/bin:/home/service/.local/bin:/usr/bin"
      );
    }
    expect(runner).toHaveBeenCalledTimes(3);
  });
});
