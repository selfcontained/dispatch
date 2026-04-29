import { describe, it, expect } from "vitest";

import type { AppConfig } from "../src/config.js";
import {
  buildAgentCommand,
  buildStartupPrompt,
  dispatchMcpUrl,
  normalizeAgentArgsForType,
} from "../src/agents/tmux/command-builder.js";

const baseConfig: AppConfig = {
  host: "127.0.0.1",
  port: 6767,
  databaseUrl: "",
  authToken: "test-token",
  mediaRoot: "/tmp/dispatch-test-media",
  dispatchBinDir: "/usr/local/bin/dispatch",
  codexBin: "/opt/codex",
  claudeBin: "/opt/claude",
  opencodeBin: "/opt/opencode",
  agentRuntime: "inert",
  sessionPrefix: "dispatch",
  tls: null,
};

const SESSION = "dispatch_agt_abc123def456_my-task";
const AGENT_ID = "agt_abc123def456";

describe("dispatchMcpUrl", () => {
  it("uses /api/mcp/<agentId> for standard agents", () => {
    expect(dispatchMcpUrl(baseConfig, AGENT_ID)).toBe(
      `http://127.0.0.1:6767/api/mcp/${AGENT_ID}`
    );
  });

  it("uses /api/mcp/jobs/<jobRunId>/<agentId> when jobRunId is supplied", () => {
    expect(dispatchMcpUrl(baseConfig, AGENT_ID, "run_jobid")).toBe(
      `http://127.0.0.1:6767/api/mcp/jobs/run_jobid/${AGENT_ID}`
    );
  });

  it("emits https:// when tls is configured", () => {
    const tlsConfig: AppConfig = {
      ...baseConfig,
      tls: { cert: Buffer.from(""), key: Buffer.from("") },
    };
    expect(dispatchMcpUrl(tlsConfig, AGENT_ID)).toMatch(/^https:\/\//);
  });
});

describe("normalizeAgentArgsForType", () => {
  it("passes Claude args through untouched (Claude CLI accepts the flag directly)", () => {
    const args = ["--append-system-prompt", "be helpful", "--verbose"];
    const result = normalizeAgentArgsForType("claude", args);
    expect(result.passthroughArgs).toEqual(args);
    expect(result.appendedSystemPrompt).toBeNull();
  });

  it("for codex, lifts --append-system-prompt out of the args", () => {
    const result = normalizeAgentArgsForType("codex", [
      "--verbose",
      "--append-system-prompt",
      "be helpful",
      "--debug",
    ]);
    expect(result.passthroughArgs).toEqual(["--verbose", "--debug"]);
    expect(result.appendedSystemPrompt).toBe("be helpful");
  });

  it("for opencode, lifts --append-system-prompt out of the args", () => {
    const result = normalizeAgentArgsForType("opencode", [
      "--append-system-prompt",
      "do this",
    ]);
    expect(result.passthroughArgs).toEqual([]);
    expect(result.appendedSystemPrompt).toBe("do this");
  });

  it("ignores --append-system-prompt with no following value (last-arg edge case)", () => {
    // Without a string value after the flag, the arg becomes uninterpretable;
    // the function leaves it in passthrough rather than silently swallowing it.
    const result = normalizeAgentArgsForType("codex", [
      "--verbose",
      "--append-system-prompt",
    ]);
    expect(result.passthroughArgs).toEqual([
      "--verbose",
      "--append-system-prompt",
    ]);
    expect(result.appendedSystemPrompt).toBeNull();
  });
});

describe("buildStartupPrompt", () => {
  it("returns just the prompt when there are no pins or media", () => {
    expect(buildStartupPrompt("do the thing", [], [])).toBe("do the thing");
  });

  it("returns undefined for empty input (caller skips prompt entirely)", () => {
    expect(buildStartupPrompt(undefined, [], [])).toBeUndefined();
    expect(buildStartupPrompt("", [], [])).toBeUndefined();
  });

  it("includes a Links section when pins are present", () => {
    const result = buildStartupPrompt(
      "ship it",
      [
        {
          label: "PR",
          value: "https://github.com/x/y/pull/1",
          type: "pr",
        },
      ],
      []
    );
    expect(result).toContain("Links:");
    expect(result).toContain("- PR: https://github.com/x/y/pull/1");
    expect(result).toContain("Instructions:\nship it");
  });

  it("drops the redundant label when label matches the URL hostname", () => {
    const result = buildStartupPrompt(
      undefined,
      [
        {
          label: "github.com",
          value: "https://github.com/x/y/pull/1",
          type: "url",
        },
      ],
      []
    );
    // When the label adds no information, the line is just `- <url>`.
    expect(result).toContain("- https://github.com/x/y/pull/1");
    expect(result).not.toContain("github.com:");
  });

  it("falls back to bare value when the pin value is not a URL", () => {
    const result = buildStartupPrompt(
      undefined,
      [{ label: "Token", value: "not a url", type: "code" }],
      []
    );
    expect(result).toContain("- not a url");
  });

  it("includes an Attached files section when media is present", () => {
    const result = buildStartupPrompt(
      undefined,
      [],
      [
        {
          fileName: "screenshot-2026.png",
          displayName: "screenshot.png",
          source: "user",
          description: "the bug",
        },
      ]
    );
    expect(result).toContain("Attached files:");
    expect(result).toContain("- screenshot.png — the bug");
  });
});

describe("buildAgentCommand", () => {
  it("for terminal type, drops the user into an interactive login shell (no CLI args)", () => {
    const cmd = buildAgentCommand(
      baseConfig,
      "terminal",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      false
    );
    expect(cmd).toContain('"${SHELL:-/bin/bash}" -il');
    // Terminal sessions never need MCP tokens or system prompts.
    expect(cmd).not.toContain("--mcp-config");
    expect(cmd).not.toContain("--append-system-prompt");
  });

  it("for claude type, includes --mcp-config, --append-system-prompt, and the cli binary", () => {
    const cmd = buildAgentCommand(
      baseConfig,
      "claude",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      false
    );
    expect(cmd).toContain("'/opt/claude'");
    expect(cmd).toContain("--mcp-config");
    expect(cmd).toContain("--append-system-prompt");
    // The launch guidance carries the agent's ID so the in-CLI banner can
    // reference it. This lock-in keeps the tmux-side rename suggestion working.
    expect(cmd).toContain(AGENT_ID);
  });

  it("for claude with cliSessionId + resume, emits --resume; without resume, emits --session-id", () => {
    const resumed = buildAgentCommand(
      baseConfig,
      "claude",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      false,
      "session-uuid",
      true
    );
    expect(resumed).toContain("--resume 'session-uuid'");
    expect(resumed).not.toContain("--session-id");

    const fresh = buildAgentCommand(
      baseConfig,
      "claude",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      false,
      "session-uuid",
      false
    );
    expect(fresh).toContain("--session-id 'session-uuid'");
    expect(fresh).not.toContain("--resume");
  });

  it("for codex type, the CLI flags include the dispatch MCP url + bearer token env var", () => {
    const cmd = buildAgentCommand(
      baseConfig,
      "codex",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      false
    );
    expect(cmd).toContain("'/opt/codex'");
    expect(cmd).toContain("mcp_servers.dispatch.url=");
    expect(cmd).toContain("mcp_servers.dispatch.bearer_token_env_var=");
    expect(cmd).toContain("DISPATCH_AUTH_TOKEN=");
  });

  it("for codex resume, emits 'codex resume <sessionId>'", () => {
    const cmd = buildAgentCommand(
      baseConfig,
      "codex",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      false,
      "codex-session",
      true
    );
    expect(cmd).toContain("'/opt/codex' resume 'codex-session'");
  });

  it("for opencode with fullAccess=true, sets OPENCODE_PERMISSION env", () => {
    const cmd = buildAgentCommand(
      baseConfig,
      "opencode",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      true
    );
    expect(cmd).toContain("OPENCODE_PERMISSION=");
    expect(cmd).toContain("bash");
  });

  it("for opencode without fullAccess, does NOT set OPENCODE_PERMISSION", () => {
    const cmd = buildAgentCommand(
      baseConfig,
      "opencode",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      false
    );
    expect(cmd).not.toContain("OPENCODE_PERMISSION=");
  });

  it("for assisted_update role, sets DISPATCH_API_URL and DISPATCH_RELEASE_UPDATE_TOKEN env", () => {
    const cmd = buildAgentCommand(
      baseConfig,
      "claude",
      "assisted_update",
      [],
      "/tmp/media",
      SESSION,
      false
    );
    expect(cmd).toContain("DISPATCH_API_URL=");
    expect(cmd).toContain("DISPATCH_RELEASE_UPDATE_TOKEN=");
  });

  it("includes Autonomous Review guidance when autoReview is true", () => {
    const cmd = buildAgentCommand(
      baseConfig,
      "claude",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      false,
      undefined,
      false,
      undefined,
      false,
      true
    );
    expect(cmd).toContain("Autonomous Review is enabled");
  });

  it("omits Autonomous Review guidance when autoReview is false", () => {
    const cmd = buildAgentCommand(
      baseConfig,
      "claude",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      false
    );
    expect(cmd).not.toContain("Autonomous Review is enabled");
  });

  it("uses jobRun-flavoured guidance when jobRunId is supplied", () => {
    const cmd = buildAgentCommand(
      baseConfig,
      "claude",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      false,
      undefined,
      false,
      "run_jobid"
    );
    expect(cmd).toContain("Dispatch job startup rules:");
    expect(cmd).toContain("job_log");
    // Job agents use the dedicated /api/mcp/jobs/<runId>/<agentId> route.
    expect(cmd).toContain("/api/mcp/jobs/run_jobid/");
  });

  it("escapes user-controllable inputs that land in env vars (mediaDir)", () => {
    // mediaDir is interpolated into DISPATCH_MEDIA_DIR=…; an attacker-controlled
    // value with a single quote must not break out of the surrounding bash
    // string. shellEscape uses the canonical '\'' idiom.
    const cmd = buildAgentCommand(
      baseConfig,
      "claude",
      "standard",
      [],
      "/tmp/it's-bad",
      SESSION,
      false
    );
    expect(cmd).toContain(`DISPATCH_MEDIA_DIR='/tmp/it'\\''s-bad'`);
  });

  it("appends extra args after the cli flags for claude", () => {
    const cmd = buildAgentCommand(
      baseConfig,
      "claude",
      "standard",
      ["--verbose"],
      "/tmp/media",
      SESSION,
      false
    );
    // The launch guidance contains newlines, so `.*` doesn't span the whole
    // command — use the dotall form via `[\s\S]*`.
    expect(cmd).toMatch(/'\/opt\/claude' [\s\S]* '--verbose'/);
    // The --verbose arg appears after the cli binary (not before).
    const claudeIdx = cmd.indexOf("'/opt/claude'");
    const verboseIdx = cmd.indexOf("'--verbose'");
    expect(verboseIdx).toBeGreaterThan(claudeIdx);
  });

  it("for claude with initialPrompt, appends the prompt as a positional arg", () => {
    const cmd = buildAgentCommand(
      baseConfig,
      "claude",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      false,
      undefined,
      false,
      undefined,
      false,
      false,
      "begin work"
    );
    expect(cmd).toContain("'begin work'");
  });
});
