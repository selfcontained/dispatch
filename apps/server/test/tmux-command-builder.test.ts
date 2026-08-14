import { afterEach, describe, it, expect, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import {
  buildAgentCommand,
  buildLaunchGuidance,
  buildStartupPrompt,
  normalizeAgentArgsForType,
} from "../src/agents/tmux/command-builder.js";
import { dispatchMcpUrl } from "../src/agents/tmux/mcp-url.js";

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
  cursorBin: "/opt/cursor",
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

  it("passes a selected model to Claude, Codex, and Cursor", () => {
    const claude = buildAgentCommand(
      baseConfig,
      "claude",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      false,
      { model: "opus" }
    );
    const codex = buildAgentCommand(
      baseConfig,
      "codex",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      false,
      { model: "gpt-5.6-terra" }
    );
    const cursor = buildAgentCommand(
      baseConfig,
      "cursor",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      false,
      { model: "auto" }
    );

    expect(claude).toContain("--model 'opus'");
    expect(codex).toContain("--model 'gpt-5.6-terra'");
    expect(cursor).toContain("--model 'auto'");
  });

  it("drops saved model flags when a selected model is supplied", () => {
    const commands = [
      buildAgentCommand(
        baseConfig,
        "claude",
        "standard",
        ["--model", "saved-model", "--verbose"],
        "/tmp/media",
        SESSION,
        false,
        { model: "opus" }
      ),
      buildAgentCommand(
        baseConfig,
        "codex",
        "standard",
        ["-m=unallowlisted", "--verbose"],
        "/tmp/media",
        SESSION,
        false,
        { model: "gpt-5.6-terra" }
      ),
      buildAgentCommand(
        baseConfig,
        "cursor",
        "standard",
        ["--model", "saved-model", "--verbose"],
        "/tmp/media",
        SESSION,
        false,
        { model: "auto" }
      ),
    ];

    for (const cmd of commands) {
      expect(cmd).not.toContain("saved-model");
      expect(cmd).toContain("'--verbose'");
      expect((cmd.match(/--model/g) ?? []).length).toBe(1);
    }
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
      { cliSessionId: "session-uuid", resume: true }
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
      { cliSessionId: "session-uuid", resume: false }
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

  it("for codex resume, emits 'codex resume <flags> <sessionId>' with the session id last", () => {
    const cmd = buildAgentCommand(
      baseConfig,
      "codex",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      false,
      { cliSessionId: "codex-session", resume: true }
    );
    expect(cmd).toContain("'/opt/codex' resume ");
    expect(cmd).toContain("mcp_servers.dispatch.url=");
    // Session id must be the trailing positional so codex binds it to
    // SESSION_ID rather than the optional PROMPT argument.
    expect(cmd.endsWith("'codex-session'")).toBe(true);
  });

  it("for codex resume, re-applies passthrough args so full access survives a restart", () => {
    const cmd = buildAgentCommand(
      baseConfig,
      "codex",
      "standard",
      ["--dangerously-bypass-approvals-and-sandbox"],
      "/tmp/media",
      SESSION,
      true,
      { cliSessionId: "codex-session", resume: true }
    );
    expect(cmd).toContain("'--dangerously-bypass-approvals-and-sandbox'");
    expect(cmd.endsWith("'codex-session'")).toBe(true);
  });

  it("for codex resume with a model, passes --model before the session id", () => {
    const cmd = buildAgentCommand(
      baseConfig,
      "codex",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      false,
      { cliSessionId: "codex-session", resume: true, model: "gpt-5.6-terra" }
    );
    expect(cmd).toContain("--model 'gpt-5.6-terra'");
    expect(cmd.indexOf("--model")).toBeLessThan(cmd.indexOf("'codex-session'"));
  });

  it("for codex resume, does not re-send the startup prompt", () => {
    const cmd = buildAgentCommand(
      baseConfig,
      "codex",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      false,
      {
        cliSessionId: "codex-session",
        resume: true,
        initialPrompt: "do the thing",
      }
    );
    expect(cmd).not.toContain("do the thing");
    expect(cmd).not.toContain("Dispatch startup rules");
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
      { autoReview: true }
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
      { jobRunId: "run_jobid" }
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

  it("for claude with initialPrompt, terminates options before the positional arg", () => {
    const cmd = buildAgentCommand(
      baseConfig,
      "claude",
      "standard",
      ["--verbose"],
      "/tmp/media",
      SESSION,
      false,
      { initialPrompt: "--- DISPATCH: REVIEW ASSIGNMENT ---\nbegin work" }
    );
    expect(cmd).toContain(
      "'--verbose' -- '--- DISPATCH: REVIEW ASSIGNMENT ---\nbegin work'"
    );
  });

  it("for claude with personalityPrompt, emits a second --append-system-prompt flag", () => {
    const cmd = buildAgentCommand(
      baseConfig,
      "claude",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      false,
      { personalityPrompt: "talk like a 1920s newspaper editor" }
    );
    const flagCount = (cmd.match(/--append-system-prompt/g) ?? []).length;
    expect(flagCount).toBe(2);
    expect(cmd).toContain("'talk like a 1920s newspaper editor'");
  });

  it("for claude without personalityPrompt, emits only one --append-system-prompt flag", () => {
    const cmd = buildAgentCommand(
      baseConfig,
      "claude",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      false
    );
    const flagCount = (cmd.match(/--append-system-prompt/g) ?? []).length;
    expect(flagCount).toBe(1);
  });

  it("for codex, personalityPrompt is folded into the startup prompt", () => {
    const cmd = buildAgentCommand(
      baseConfig,
      "codex",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      false,
      { personalityPrompt: "be terse" }
    );
    expect(cmd).toContain("be terse");
  });
});

describe("buildAgentCommand — host-env reads (process.env / process.platform)", () => {
  // The function reads a handful of values from the host environment
  // rather than from AppConfig. The JSDoc lists them; these tests pin
  // down the conditional branches so a future refactor (threading them
  // into config) can't silently change behaviour.

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("PATH prefix: includes ~/.local/bin when HOME is set", () => {
    vi.stubEnv("HOME", "/home/agentuser");
    const cmd = buildAgentCommand(
      baseConfig,
      "claude",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      false
    );
    // Expected: dispatchBinDir + ~/.local/bin joined by ':' — the order
    // is dispatchBinDir first because that's where the wrapper scripts live.
    expect(cmd).toContain(
      `PATH='/usr/local/bin/dispatch:/home/agentuser/.local/bin':$PATH`
    );
  });

  it("PATH prefix: omits ~/.local/bin when HOME is unset", () => {
    vi.stubEnv("HOME", "");
    const cmd = buildAgentCommand(
      baseConfig,
      "claude",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      false
    );
    expect(cmd).toContain(`PATH='/usr/local/bin/dispatch':$PATH`);
    expect(cmd).not.toContain("/.local/bin");
  });

  it("DISPATCH_COPY_DISPLAY: forwards on linux when set", () => {
    vi.stubEnv("DISPATCH_COPY_DISPLAY", ":99");
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
    try {
      const cmd = buildAgentCommand(
        baseConfig,
        "claude",
        "standard",
        [],
        "/tmp/media",
        SESSION,
        false
      );
      expect(cmd).toContain(`DISPATCH_COPY_DISPLAY=':99'`);
      // Also exported as the standard DISPLAY so the agent CLI's Ctrl+V image
      // paste can read the Xvfb clipboard.
      expect(cmd).toContain(`DISPLAY=':99'`);
    } finally {
      Object.defineProperty(process, "platform", {
        value: process.platform === "linux" ? "linux" : "darwin",
        configurable: true,
      });
    }
  });

  it("DISPATCH_COPY_DISPLAY: never forwarded on non-linux platforms", () => {
    vi.stubEnv("DISPATCH_COPY_DISPLAY", ":99");
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
    const cmd = buildAgentCommand(
      baseConfig,
      "claude",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      false
    );
    expect(cmd).not.toContain("DISPATCH_COPY_DISPLAY=");
  });

  it("TLS_CA: sets NODE_EXTRA_CA_CERTS when TLS is configured AND TLS_CA is set", () => {
    vi.stubEnv("TLS_CA", "/etc/dispatch/rootCA.pem");
    const tlsConfig: AppConfig = {
      ...baseConfig,
      tls: { cert: Buffer.from(""), key: Buffer.from("") },
    };
    const cmd = buildAgentCommand(
      tlsConfig,
      "claude",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      false
    );
    expect(cmd).toContain(`NODE_EXTRA_CA_CERTS='/etc/dispatch/rootCA.pem'`);
  });

  it("TLS_CA: NOT set when TLS_CA is configured but TLS is not enabled", () => {
    vi.stubEnv("TLS_CA", "/etc/dispatch/rootCA.pem");
    // baseConfig has tls: null
    const cmd = buildAgentCommand(
      baseConfig,
      "claude",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      false
    );
    expect(cmd).not.toContain("NODE_EXTRA_CA_CERTS");
  });

  it("TLS_CA: NOT set when TLS is enabled but TLS_CA is not configured", () => {
    vi.stubEnv("TLS_CA", "");
    const tlsConfig: AppConfig = {
      ...baseConfig,
      tls: { cert: Buffer.from(""), key: Buffer.from("") },
    };
    const cmd = buildAgentCommand(
      tlsConfig,
      "claude",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      false
    );
    expect(cmd).not.toContain("NODE_EXTRA_CA_CERTS");
  });
});

describe("buildLaunchGuidance — trimmed variant", () => {
  const PLAYWRIGHT_RULE = "Playwright: default headless.";
  const SHARE_NUDGE = "Share artifacts with dispatch_share";
  const CREATE_PR_RULE = "use the create_pr MCP tool";
  const REVIEW_DETAIL = "structured REVIEW SUBMITTED prompt";

  // Rules with no task-shaped trigger for a skill description to match on —
  // these must survive the trim in every variant.
  const ALWAYS_ON = [
    "No task, no work.",
    "Name the session.",
    "Report status with dispatch_event.",
    "Pin key info with dispatch_pin",
    "Offer a shortcut pin",
  ];

  function guidance(opts: Parameters<typeof buildLaunchGuidance>[1]): string {
    return buildLaunchGuidance(AGENT_ID, opts);
  }

  it("keeps the full ruleset when the setting is off", () => {
    const text = guidance({ agentType: "claude", suggestSessionRename: true });
    expect(text).toContain(PLAYWRIGHT_RULE);
    expect(text).not.toContain(SHARE_NUDGE);
    expect(text).toContain(CREATE_PR_RULE);
  });

  it("swaps the Playwright rule for a short dispatch_share nudge when trimmed", () => {
    const text = guidance({
      agentType: "claude",
      suggestSessionRename: true,
      trimmedGuidance: true,
    });
    expect(text).not.toContain(PLAYWRIGHT_RULE);
    expect(text).toContain(SHARE_NUDGE);
  });

  it("keeps the create_pr tool-routing rule verbatim when trimmed", () => {
    const text = guidance({ agentType: "claude", trimmedGuidance: true });
    expect(text).toContain(CREATE_PR_RULE);
  });

  it("shortens the Autonomous Review block but keeps its runtime protocol", () => {
    const full = guidance({ agentType: "claude", autoReview: true });
    const trimmed = guidance({
      agentType: "claude",
      autoReview: true,
      trimmedGuidance: true,
    });
    expect(full).toContain(REVIEW_DETAIL);
    expect(trimmed).toContain("Autonomous Review is enabled");
    expect(trimmed).not.toContain(REVIEW_DETAIL);
    // The bits Dispatch's runtime depends on stay in the always-on text.
    expect(trimmed).toContain("do not poll");
    expect(trimmed).toContain("create_pr");
    expect(trimmed).toContain("dispatch_launch_persona");
    expect(trimmed.length).toBeLessThan(full.length);
  });

  it("omits the Autonomous Review rule entirely when autoReview is off", () => {
    const text = guidance({ agentType: "claude", trimmedGuidance: true });
    expect(text).not.toContain("Autonomous Review is enabled");
  });

  it("never trims the always-on rules", () => {
    const text = guidance({
      agentType: "claude",
      suggestSessionRename: true,
      autoReview: true,
      trimmedGuidance: true,
    });
    for (const rule of ALWAYS_ON) expect(text).toContain(rule);
  });

  it("ignores the setting for agent types with no Dispatch plugin", () => {
    for (const agentType of ["opencode", "cursor"] as const) {
      const text = guidance({
        agentType,
        autoReview: true,
        trimmedGuidance: true,
      });
      expect(text).toContain(PLAYWRIGHT_RULE);
      expect(text).toContain(REVIEW_DETAIL);
    }
  });

  it("applies to codex as well as claude", () => {
    const text = guidance({ agentType: "codex", trimmedGuidance: true });
    expect(text).toContain(SHARE_NUDGE);
    expect(text).not.toContain(PLAYWRIGHT_RULE);
  });

  it("leaves job-run guidance identical — every rule there is protocol", () => {
    const opts = {
      agentType: "claude",
      jobRunId: "run_1",
      suggestSessionRename: true,
    } as const;
    expect(guidance({ ...opts, trimmedGuidance: true })).toBe(guidance(opts));
  });

  it("threads the setting through buildAgentCommand", () => {
    const cmd = buildAgentCommand(
      baseConfig,
      "claude",
      "standard",
      [],
      "/tmp/media",
      SESSION,
      false,
      { autoReview: true, trimmedGuidance: true }
    );
    expect(cmd).toContain(SHARE_NUDGE);
    expect(cmd).not.toContain(PLAYWRIGHT_RULE);
  });
});
