import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  beforeEach,
  vi,
} from "vitest";
import type { Pool } from "pg";

import { setupTestDb, teardownTestDb, runTestMigrations } from "./setup.js";
import { buildPersonaKickoffPrompt } from "../../src/reviews/injection-prompts.js";

// Mock runCommand so AgentManager never touches tmux
vi.mock("../../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(async (_cmd: string, args: string[]) => {
    // "has-session" check: pretend session exists after creation
    if (args[0] === "has-session") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }),
}));

// We need to dynamically import AgentManager AFTER the mock is in place
const { AgentManager, AgentError } =
  await import("../../src/agents/manager.js");
const feedbackQueries = await import("../../src/agents/feedback.js");
const personaReviewQueries =
  await import("../../src/agents/persona-reviews.js");
const { createAgentMcpToken } = await import("../../src/auth.js");
const execFileAsync = promisify(execFile);

let pool: Pool;

// Minimal logger that satisfies FastifyBaseLogger shape
const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => noopLogger,
  silent: () => {},
  level: "silent",
} as unknown as import("fastify").FastifyBaseLogger;

const testConfig = {
  host: "127.0.0.1",
  port: 6767,
  databaseUrl: "",
  authToken: "test-token",
  mediaRoot: "/tmp/dispatch-test-media",
  dispatchBinDir: "/tmp",
  codexBin: "echo",
  claudeBin: "echo",
  opencodeBin: "echo",
  cursorBin: "echo",
  agentRuntime: "tmux",
  sessionPrefix: "dispatch",
  tls: null,
} satisfies import("../../src/config.js").AppConfig;

const inertTestConfig = {
  ...testConfig,
  agentRuntime: "inert",
} satisfies import("../../src/config.js").AppConfig;

let manager: InstanceType<typeof AgentManager>;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  manager = new AgentManager(pool, noopLogger, testConfig);
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  // Clean up agents between tests
  await pool.query("DELETE FROM agent_token_usage");
  await pool.query("DELETE FROM agent_feedback");
  await pool.query("DELETE FROM media_seen");
  await pool.query("DELETE FROM media");
  await pool.query("DELETE FROM agents");

  const { runCommand } = await import("../../src/shared/lib/run-command.js");
  vi.mocked(runCommand).mockImplementation(
    async (_cmd: string, args: string[]) => {
      if (args[0] === "has-session") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
  );
});

describe("AgentManager", () => {
  describe("createAgent", () => {
    it("should create an agent and return it", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      expect(agent.id).toMatch(/^agt_/);
      expect(agent.status).toBe("creating");
      expect(agent.setupPhase).toBe("session");
      expect(agent.cwd).toBe("/tmp");
      expect(agent.type).toBe("codex");
      expect(agent.role).toBe("standard");
      expect(agent.tmuxSession).toMatch(/^dispatch_agt_/);
      expect(agent.mediaDir).toBeTruthy();
      expect(agent.createdAt).toBeTruthy();
    });

    it("should use a custom name when provided", async () => {
      const agent = await manager.createAgent({
        name: "my-agent",
        cwd: "/tmp",
        useWorktree: false,
      });
      expect(agent.name).toBe("my-agent");
    });

    it("should generate a default name from ID suffix", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      expect(agent.name).toMatch(/^agent-/);
    });

    it("should support claude agent type", async () => {
      const agent = await manager.createAgent({
        type: "claude",
        cwd: "/tmp",
        useWorktree: false,
      });
      expect(agent.type).toBe("claude");
    });

    it("should support opencode agent type", async () => {
      const agent = await manager.createAgent({
        type: "opencode",
        cwd: "/tmp",
        useWorktree: false,
      });
      expect(agent.type).toBe("opencode");
    });

    it("should persist assisted update role when provided", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        role: "assisted_update",
        useWorktree: false,
      });
      expect(agent.role).toBe("assisted_update");
    });

    it("should inject explicit update API auth and instructions for assisted update agents", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        role: "assisted_update",
        type: "codex",
        useWorktree: false,
        initialPrompt: [
          "You are running an assisted Dispatch update on the host machine.",
          "Trigger the existing managed Dispatch update flow first by calling the built-in update endpoint the UI uses with the provided bearer token.",
          `curl -sf -X POST "$DISPATCH_API_URL/api/v1/release/update" -H "Content-Type: application/json" -H "Authorization: Bearer $DISPATCH_RELEASE_UPDATE_TOKEN" -d '{\"tag\":\"v9.9.9\"}'`,
        ].join("\n"),
      });

      const setupScript = await readFile(
        `/tmp/dispatch_setup_${agent.id}.sh`,
        "utf-8"
      );
      expect(setupScript).toContain("DISPATCH_API_URL=");
      expect(setupScript).toContain("DISPATCH_RELEASE_UPDATE_TOKEN=");
      expect(setupScript).toContain(
        'curl -sf -X POST "$DISPATCH_API_URL/api/v1/release/update"'
      );
      expect(setupScript).toContain(
        "Authorization: Bearer $DISPATCH_RELEASE_UPDATE_TOKEN"
      );
    });

    it("should persist reviewAgentType when provided", async () => {
      const agent = await manager.createAgent({
        type: "codex",
        reviewAgentType: "claude",
        cwd: "/tmp",
        useWorktree: false,
      });
      expect(agent.reviewAgentType).toBe("claude");
    });

    it("should store agentArgs", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        agentArgs: ["--model", "o3"],
        useWorktree: false,
      });
      expect(agent.agentArgs).toEqual(["--model", "o3"]);
    });

    it("de-duplicates initialPins by case-insensitive label (last write wins)", async () => {
      // The createAgent path bypasses upsertPin's "later upsert overwrites
      // earlier" loop, so it has to apply the same de-dup rule itself.
      // Otherwise the seeded pins would carry duplicates that upsertPin
      // would silently merge later.
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
        initialPins: [
          { label: "PR", value: "https://example.com/pr/1", type: "pr" },
          { label: "pr", value: "https://example.com/pr/2", type: "pr" },
        ],
      });
      expect(agent.pins).toHaveLength(1);
      expect(agent.pins[0]?.value).toBe("https://example.com/pr/2");
    });

    it("rejects initialPins that exceed the 50-pin cap (quota bypass guard)", async () => {
      // Without this guard, /api/v1/agents was a vector for piling
      // unbounded pins into a fresh agent — both a DB-row size concern
      // and a prompt-bloat concern (pins flow into buildStartupPrompt).
      const tooMany = Array.from({ length: 51 }, (_, i) => ({
        label: `pin-${i}`,
        value: `value-${i}`,
        type: "string" as const,
      }));
      await expect(
        manager.createAgent({
          cwd: "/tmp",
          useWorktree: false,
          initialPins: tooMany,
        })
      ).rejects.toThrow(/more than 50 initial pins/);
    });

    it("counts post-dedup against the 50-pin cap, not pre-dedup", async () => {
      // 51 entries that all collapse to the same label should pass —
      // de-dup runs first, cap check runs against the deduped count.
      const allSameLabel = Array.from({ length: 51 }, (_, i) => ({
        label: "duplicate",
        value: `value-${i}`,
        type: "string" as const,
      }));
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
        initialPins: allSameLabel,
      });
      expect(agent.pins).toHaveLength(1);
    });

    it("should persist fullAccess", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        fullAccess: true,
        useWorktree: false,
      });
      expect(agent.fullAccess).toBe(true);
      expect(agent.agentArgs).toContain(
        "--dangerously-bypass-approvals-and-sandbox"
      );
    });

    it("should append the claude full access flag for direct launches", async () => {
      const agent = await manager.createAgent({
        type: "claude",
        cwd: "/tmp",
        fullAccess: true,
        useWorktree: false,
      });
      expect(agent.fullAccess).toBe(true);
      expect(agent.agentArgs).toContain("--dangerously-skip-permissions");
    });

    it("should persist autoReview", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        autoReview: true,
        useWorktree: false,
      });
      expect(agent.autoReview).toBe(true);
    });

    it("should default autoReview to false", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      expect(agent.autoReview).toBe(false);
    });

    it("should persist baseBranch when provided", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        baseBranch: "feature/foo",
        useWorktree: false,
      });
      expect(agent.baseBranch).toBe("feature/foo");
    });

    it("should default baseBranch to null when not provided for non-worktree agents", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      expect(agent.baseBranch).toBeNull();
    });

    it("should default baseBranch to main for worktree agents when not provided", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: true,
      });
      expect(agent.baseBranch).toBe("main");
    });

    it("should reject non-absolute paths", async () => {
      await expect(
        manager.createAgent({ cwd: "relative/path" })
      ).rejects.toThrow("absolute path");
    });

    it("should reject non-existent directories", async () => {
      await expect(
        manager.createAgent({ cwd: "/nonexistent-dispatch-test-dir" })
      ).rejects.toThrow("does not exist");
    });

    it("should create inert agents without invoking tmux", async () => {
      const { runCommand } =
        await import("../../src/shared/lib/run-command.js");
      const inertManager = new AgentManager(pool, noopLogger, inertTestConfig);
      vi.mocked(runCommand).mockClear();

      const agent = await inertManager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      expect(agent.status).toBe("running");
      // Inert mode skips the tmux runtime, but the inline git-context
      // probe still runs against the agent's cwd. Assert specifically
      // that no `tmux` subprocess was launched.
      const tmuxCalls = vi
        .mocked(runCommand)
        .mock.calls.filter(([cmd]) => cmd === "tmux");
      expect(tmuxCalls).toHaveLength(0);
    });

    it("should inject an agent-scoped MCP URL into Codex launches", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        type: "codex",
        useWorktree: false,
      });

      // The setup script should contain the MCP configuration
      const setupScript = await readFile(
        `/tmp/dispatch_setup_${agent.id}.sh`,
        "utf-8"
      );
      expect(setupScript).toContain("mcp_servers.dispatch.url=");
      expect(setupScript).toContain(`/api/mcp/${agent.id}`);
      expect(setupScript).toContain(
        "mcp_servers.dispatch.bearer_token_env_var="
      );
      expect(setupScript).toContain("DISPATCH_AUTH_TOKEN=");
      expect(setupScript).toMatch(/Dispatch startup rules:\n1\. /);
      expect(setupScript).not.toContain("MANDATORY FIRST ACTION");
      expect(setupScript).not.toContain("functions.dispatch-dispatch_event");
      expect(setupScript).not.toContain(
        "Do not say Dispatch tools are unavailable"
      );
      expect(setupScript).toContain(
        "infer a task from branch/worktree context alone"
      );
      expect(setupScript).toContain("dispatch_rename_session");
      expect(setupScript).toContain(
        "short name for that topic, task, or feature"
      );
      expect(setupScript).toContain(
        "stable label describing what the session is about"
      );
    });

    it("should include Cursor-specific Dispatch tool guidance for Cursor launches", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        type: "cursor",
        useWorktree: false,
      });

      const setupScript = await readFile(
        `/tmp/dispatch_setup_${agent.id}.sh`,
        "utf-8"
      );
      expect(setupScript).toContain("MANDATORY FIRST ACTION");
      expect(setupScript).toContain(
        "Before reading files, running git, or replying"
      );
      expect(setupScript).toContain(
        'functions.dispatch-dispatch_event({ type: "working", message: "Starting" })'
      );
      expect(setupScript).toContain(
        "Do not say Dispatch tools are unavailable"
      );
      expect(setupScript).toContain("dispatch-dispatch_feedback");
      expect(setupScript).toContain("report the exact tool error");
    });

    it("should skip rename guidance when the user provided a custom name", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        type: "codex",
        name: "bug bash",
        useWorktree: false,
      });

      const setupScript = await readFile(
        `/tmp/dispatch_setup_${agent.id}.sh`,
        "utf-8"
      );
      expect(setupScript).not.toContain(
        "Name the session. Once the topic of work is clear"
      );
    });

    it("should skip rename guidance for custom names that resemble the default pattern", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        type: "codex",
        name: "agent-foobar",
        useWorktree: false,
      });

      const setupScript = await readFile(
        `/tmp/dispatch_setup_${agent.id}.sh`,
        "utf-8"
      );
      expect(setupScript).not.toContain(
        "Name the session. Once the topic of work is clear"
      );
    });

    it("should skip rename guidance for persona agents", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        type: "codex",
        name: "security-review-123456",
        persona: "security-review",
        useWorktree: false,
      });

      const setupScript = await readFile(
        `/tmp/dispatch_setup_${agent.id}.sh`,
        "utf-8"
      );
      expect(setupScript).not.toContain(
        "Name the session. Once the topic of work is clear"
      );
    });

    it("should translate appended system prompts into a single Codex startup prompt", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        type: "codex",
        useWorktree: false,
        agentArgs: [
          "--append-system-prompt",
          "Persona review instructions",
          "--model",
          "gpt-5",
        ],
      });

      const setupScript = await readFile(
        `/tmp/dispatch_setup_${agent.id}.sh`,
        "utf-8"
      );
      expect(setupScript).toContain("Persona review instructions");
      expect(setupScript).toContain("--model");
      expect(setupScript).not.toContain("--append-system-prompt");
    });

    it.each(["claude", "codex", "opencode"] as const)(
      "should deliver the persona kickoff prompt to %s launches",
      async (type) => {
        const personaPrompt = "Persona review instructions";
        const agent = await manager.createAgent({
          cwd: "/tmp",
          type,
          useWorktree: false,
          agentArgs: ["--append-system-prompt", personaPrompt],
          initialPrompt: buildPersonaKickoffPrompt(),
        });

        const setupScript = await readFile(
          `/tmp/dispatch_setup_${agent.id}.sh`,
          "utf-8"
        );
        const kickoffMatches = setupScript.match(/Begin your review now\./g);

        expect(kickoffMatches).toHaveLength(1);
        expect(setupScript).toContain(personaPrompt);
        expect(setupScript).toContain("loaded into your context");
      }
    );

    it("should inject an agent-scoped MCP URL into Claude launches", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        type: "claude",
        useWorktree: false,
      });

      // The setup script should contain the MCP configuration
      const setupScript = await readFile(
        `/tmp/dispatch_setup_${agent.id}.sh`,
        "utf-8"
      );
      expect(setupScript).toContain("--mcp-config");
      expect(setupScript).toContain(`/api/mcp/${agent.id}`);
    });

    it("should inject an agent-scoped MCP config into OpenCode launches without inline JSON quoting bugs", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        type: "opencode",
        useWorktree: false,
      });

      const setupScript = await readFile(
        `/tmp/dispatch_setup_${agent.id}.sh`,
        "utf-8"
      );
      expect(setupScript).toContain(`MCP_ENTRY='{"type":"remote"`);
      expect(setupScript).toContain(`node --input-type=module -e`);
      expect(setupScript).toContain(`/api/mcp/${agent.id}`);
      expect(setupScript).not.toContain(`python3 -c`);
    });

    it("should execute the generated OpenCode MCP config merge script", async () => {
      const tempDir = await mkdtemp(
        path.join(os.tmpdir(), "dispatch-opencode-config-")
      );
      try {
        await writeFile(
          path.join(tempDir, "opencode.json"),
          JSON.stringify({
            theme: "system",
            mcp: {
              existing: { type: "local", command: ["echo", "ok"] },
            },
          })
        );

        const agent = await manager.createAgent({
          cwd: "/tmp",
          type: "opencode",
          useWorktree: false,
        });
        const setupScript = await readFile(
          `/tmp/dispatch_setup_${agent.id}.sh`,
          "utf-8"
        );
        const configBlock = setupScript.match(
          /# --- Configure opencode MCP ---\n(?<block>[\s\S]*?)\n# exec replaces this shell/
        )?.groups?.block;
        expect(configBlock).toBeTruthy();

        await execFileAsync("bash", [
          "-c",
          `set -euo pipefail\nok() { :; }\nEFFECTIVE_CWD=${JSON.stringify(tempDir)}\n${configBlock}`,
        ]);

        const config = JSON.parse(
          await readFile(path.join(tempDir, "opencode.json"), "utf-8")
        );
        expect(config.theme).toBe("system");
        expect(config.mcp.existing).toEqual({
          type: "local",
          command: ["echo", "ok"],
        });
        expect(config.mcp.dispatch).toEqual({
          type: "remote",
          url: `http://127.0.0.1:6767/api/mcp/${agent.id}`,
          headers: {
            Authorization: `Bearer ${createAgentMcpToken("test-token", agent.id)}`,
          },
        });
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("should include autonomous review guidance when autoReview is true", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        type: "claude",
        autoReview: true,
        useWorktree: false,
      });

      const setupScript = await readFile(
        `/tmp/dispatch_setup_${agent.id}.sh`,
        "utf-8"
      );
      expect(setupScript).toContain("Autonomous Review is enabled");
      expect(setupScript).toContain("list_personas");
      expect(setupScript).toContain("dispatch_launch_persona");
      expect(setupScript).toContain("dispatch_get_feedback");
      expect(setupScript).toContain("wait for server-injected review prompts");
      expect(setupScript).toContain("launch 1 relevant reviewer");
      expect(setupScript).not.toContain("Poll dispatch_get_feedback");
      expect(setupScript).not.toContain("Only launch additional reviewers");
    });

    it("should include draft PR guidance in autonomous review", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        type: "claude",
        autoReview: true,
        useWorktree: false,
      });

      const setupScript = await readFile(
        `/tmp/dispatch_setup_${agent.id}.sh`,
        "utf-8"
      );
      expect(setupScript).toContain("open a draft PR via create_pr");
      expect(setupScript).toContain("override baseBranch");
    });

    it("should not include autonomous review guidance when autoReview is false", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        type: "claude",
        autoReview: false,
        useWorktree: false,
      });

      const setupScript = await readFile(
        `/tmp/dispatch_setup_${agent.id}.sh`,
        "utf-8"
      );
      expect(setupScript).not.toContain("Autonomous Review is enabled");
    });

    it("should not include autonomous review guidance for persona agents even if autoReview is true", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        type: "claude",
        autoReview: true,
        persona: "security-review",
        useWorktree: false,
      });

      const setupScript = await readFile(
        `/tmp/dispatch_setup_${agent.id}.sh`,
        "utf-8"
      );
      expect(setupScript).not.toContain("Autonomous Review is enabled");
    });

    it("should include autonomous review guidance for Codex agents", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        type: "codex",
        autoReview: true,
        useWorktree: false,
      });

      const setupScript = await readFile(
        `/tmp/dispatch_setup_${agent.id}.sh`,
        "utf-8"
      );
      expect(setupScript).toContain("Autonomous Review is enabled");
      expect(setupScript).toContain("list_personas");
    });

    it("should not include autonomous review guidance for job agents", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        type: "claude",
        autoReview: true,
        jobRunId: "run_abc123",
        useWorktree: false,
      });

      const setupScript = await readFile(
        `/tmp/dispatch_setup_${agent.id}.sh`,
        "utf-8"
      );
      expect(setupScript).not.toContain("Autonomous Review is enabled");
      expect(setupScript).toContain("Dispatch job startup rules");
    });

    it("should include rename guidance for job agents with default names", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        type: "codex",
        name: "job-rename-test-run_abc1",
        jobRunId: "run_abc123",
        useWorktree: false,
      });

      const setupScript = await readFile(
        `/tmp/dispatch_setup_${agent.id}.sh`,
        "utf-8"
      );
      expect(setupScript).toMatch(/Dispatch job startup rules:\n1\. /);
      expect(setupScript).not.toContain("MANDATORY FIRST ACTION");
      expect(setupScript).not.toContain("functions.dispatch-dispatch_event");
      expect(setupScript).toContain(
        "Report status with dispatch_event to keep the UI current"
      );
      expect(setupScript).toContain("Log task-level progress with job_log");
      expect(setupScript).toContain("dispatch_rename_session");
      expect(setupScript).toContain(
        "short name for that topic, task, or feature"
      );
    });

    it("should include Cursor-specific Dispatch tool guidance for Cursor job agents", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        type: "cursor",
        name: "job-cursor-test-run_abc1",
        jobRunId: "run_abc123",
        useWorktree: false,
      });

      const setupScript = await readFile(
        `/tmp/dispatch_setup_${agent.id}.sh`,
        "utf-8"
      );
      expect(setupScript).toMatch(/Dispatch job startup rules:\n1\. /);
      expect(setupScript).toContain("MANDATORY FIRST ACTION");
      expect(setupScript).toContain(
        'functions.dispatch-dispatch_event({ type: "working", message: "Starting" })'
      );
      expect(setupScript).toContain(
        "Do not say Dispatch tools are unavailable"
      );
      expect(setupScript).toContain("Log task-level progress with job_log");
    });

    it("should generate a setup script with worktree steps when useWorktree is true", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        type: "claude",
        useWorktree: true,
      });

      expect(agent.setupPhase).toBe("worktree");
      const setupScript = await readFile(
        `/tmp/dispatch_setup_${agent.id}.sh`,
        "utf-8"
      );
      expect(setupScript).toContain("Creating git worktree");
      expect(setupScript).toContain("Copying environment files");
      expect(setupScript).toContain("Installing dependencies");
      expect(setupScript).toContain("Starting agent session");
      expect(setupScript).toContain("setup/complete");
      expect(setupScript).toContain("exec bash");
    });

    it("should skip worktree steps in setup script when useWorktree is false", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        type: "claude",
        useWorktree: false,
      });

      expect(agent.setupPhase).toBe("session");
      const setupScript = await readFile(
        `/tmp/dispatch_setup_${agent.id}.sh`,
        "utf-8"
      );
      expect(setupScript).not.toContain("Creating git worktree");
      expect(setupScript).toContain("Starting agent session");
      expect(setupScript).toContain("exec bash");
    });

    it("should complete setup and transition to running", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      expect(agent.status).toBe("creating");

      const updated = await manager.completeSetup(agent.id, {
        effectiveCwd: "/tmp/worktree",
        worktreePath: "/tmp/worktree",
        worktreeBranch: "test-branch",
      });

      expect(updated.status).toBe("running");
      expect(updated.cwd).toBe("/tmp/worktree");
      expect(updated.worktreePath).toBe("/tmp/worktree");
      expect(updated.worktreeBranch).toBe("test-branch");
      expect(updated.setupPhase).toBeNull();
    });
  });

  describe("getAgent / listAgents", () => {
    it("should return null for non-existent agent", async () => {
      const agent = await manager.getAgent("agt_does_not_exist");
      expect(agent).toBeNull();
    });

    it("should list created agents in descending order", async () => {
      await manager.createAgent({
        name: "first",
        cwd: "/tmp",
        useWorktree: false,
      });
      await manager.createAgent({
        name: "second",
        cwd: "/tmp",
        useWorktree: false,
      });

      const agents = await manager.listAgents();
      expect(agents.length).toBe(2);
      expect(agents[0].name).toBe("second");
      expect(agents[1].name).toBe("first");
    });

    it("should fetch a single agent by ID", async () => {
      const created = await manager.createAgent({
        name: "fetch-me",
        cwd: "/tmp",
        useWorktree: false,
      });
      const fetched = await manager.getAgent(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.name).toBe("fetch-me");
    });

    it("should round-trip autoReview through getAgent", async () => {
      const created = await manager.createAgent({
        cwd: "/tmp",
        autoReview: true,
        useWorktree: false,
      });
      const fetched = await manager.getAgent(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched!.autoReview).toBe(true);
    });

    it("should include autoReview in listAgents results", async () => {
      await manager.createAgent({
        name: "review-on",
        cwd: "/tmp",
        autoReview: true,
        useWorktree: false,
      });
      await manager.createAgent({
        name: "review-off",
        cwd: "/tmp",
        autoReview: false,
        useWorktree: false,
      });

      const agents = await manager.listAgents();
      const reviewOn = agents.find((a) => a.name === "review-on");
      const reviewOff = agents.find((a) => a.name === "review-off");

      expect(reviewOn!.autoReview).toBe(true);
      expect(reviewOff!.autoReview).toBe(false);
    });

    it("should rename an agent", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      const renamed = await manager.renameAgent(
        agent.id,
        "Investigate flaky e2e"
      );

      expect(renamed.name).toBe("Investigate flaky e2e");
    });

    it("should reject empty agent names when renaming", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await expect(manager.renameAgent(agent.id, "   ")).rejects.toThrow(
        "Agent name must not be empty."
      );
    });

    it("should update reviewAgentType", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await manager.updateReviewAgentType(agent.id, "opencode");
      const updated = await manager.getAgent(agent.id);

      expect(updated?.reviewAgentType).toBe("opencode");
    });
  });

  describe("getTerminalAccess", () => {
    it("should return inert terminal metadata for inert runtime agents", async () => {
      const inertManager = new AgentManager(pool, noopLogger, inertTestConfig);
      const agent = await inertManager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      const access = await inertManager.getTerminalAccess(agent.id);

      expect(access.mode).toBe("inert");
      expect(access.message).toContain("inert mode");
    });

    it("should return inert terminal metadata even without tmux session metadata", async () => {
      const inertManager = new AgentManager(pool, noopLogger, inertTestConfig);
      const agent = await inertManager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await pool.query("UPDATE agents SET tmux_session = NULL WHERE id = $1", [
        agent.id,
      ]);

      const access = await inertManager.getTerminalAccess(agent.id);

      expect(access.mode).toBe("inert");
      expect(access.message).toContain("inert mode");
    });
  });

  describe("upsertLatestEvent", () => {
    it("should persist an event on an agent", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      const updated = await manager.upsertLatestEvent(agent.id, {
        type: "working",
        message: "Doing stuff",
      });

      expect(updated.latestEvent).not.toBeNull();
      expect(updated.latestEvent!.type).toBe("working");
      expect(updated.latestEvent!.message).toBe("Doing stuff");
      expect(updated.latestEvent!.updatedAt).toBeTruthy();
    });

    it("should overwrite a previous event", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await manager.upsertLatestEvent(agent.id, {
        type: "working",
        message: "Step 1",
      });

      const updated = await manager.upsertLatestEvent(agent.id, {
        type: "done",
        message: "Step 2",
      });

      expect(updated.latestEvent!.type).toBe("done");
      expect(updated.latestEvent!.message).toBe("Step 2");
    });

    it("should store metadata", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      const updated = await manager.upsertLatestEvent(agent.id, {
        type: "blocked",
        message: "Waiting on build",
        metadata: { source: "ci", buildId: "123" },
      });

      expect(updated.latestEvent!.metadata).toEqual({
        source: "ci",
        buildId: "123",
      });
    });

    it("should reject empty message", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await expect(
        manager.upsertLatestEvent(agent.id, { type: "working", message: "  " })
      ).rejects.toThrow("non-empty");
    });

    it("should return 404 for non-existent agent", async () => {
      try {
        await manager.upsertLatestEvent("agt_nonexistent", {
          type: "working",
          message: "hello",
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AgentError);
        expect((err as InstanceType<typeof AgentError>).statusCode).toBe(404);
      }
    });
  });

  describe("archiveAgent", () => {
    /** Helper: run the full beginArchive + executeArchive flow and wait for completion. */
    async function archiveAgent(
      id: string,
      cleanupWorktree: "auto" | "keep" | "force" = "auto"
    ): Promise<void> {
      await manager.beginArchive(id, cleanupWorktree);
      await new Promise<void>((resolve, reject) => {
        void manager.executeArchive(id, {
          onPhaseChange: () => {},
          onComplete: () => resolve(),
          onError: (err) => reject(err),
        });
      });
    }

    it("should soft-delete an agent", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      // Stop first so beginArchive doesn't need force
      await manager.stopAgent(agent.id, { force: true });
      await archiveAgent(agent.id);

      // getAgent filters out soft-deleted agents
      const fetched = await manager.getAgent(agent.id);
      expect(fetched).toBeNull();

      // But the row still exists in the database with deleted_at set
      const row = await pool.query(
        "SELECT deleted_at FROM agents WHERE id = $1",
        [agent.id]
      );
      expect(row.rowCount).toBe(1);
      expect(row.rows[0].deleted_at).not.toBeNull();
    });

    it("should exclude soft-deleted agents from listAgents", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      await manager.stopAgent(agent.id, { force: true });
      await archiveAgent(agent.id);

      const agents = await manager.listAgents();
      expect(agents.find((a) => a.id === agent.id)).toBeUndefined();
    });

    it("should preserve media rows after soft delete", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      // Insert media directly
      await pool.query(
        `INSERT INTO media (agent_id, file_name, source, size_bytes) VALUES ($1, 'test.png', 'screenshot', 100)`,
        [agent.id]
      );
      await pool.query(
        `INSERT INTO media_seen (agent_id, media_key) VALUES ($1, 'test.png')`,
        [agent.id]
      );

      await archiveAgent(agent.id);

      // Media rows are preserved since soft delete doesn't trigger CASCADE
      const media = await pool.query(
        "SELECT * FROM media WHERE agent_id = $1",
        [agent.id]
      );
      const seen = await pool.query(
        "SELECT * FROM media_seen WHERE agent_id = $1",
        [agent.id]
      );
      expect(media.rowCount).toBe(1);
      expect(seen.rowCount).toBe(1);
    });

    it("should throw 404 for non-existent agent", async () => {
      try {
        await manager.beginArchive("agt_nonexistent");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AgentError);
        expect((err as InstanceType<typeof AgentError>).statusCode).toBe(404);
      }
    });

    it("should set status to archiving during beginArchive", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      await manager.stopAgent(agent.id, { force: true });

      const archiving = await manager.beginArchive(agent.id);
      expect(archiving.status).toBe("archiving");
      expect(archiving.archivePhase).toBe("stopping");
    });

    it("should reject archiving an already-archiving agent", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      await manager.stopAgent(agent.id, { force: true });
      await manager.beginArchive(agent.id);

      try {
        await manager.beginArchive(agent.id);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AgentError);
        expect((err as InstanceType<typeof AgentError>).statusCode).toBe(409);
      }
    });
  });

  describe("stopAgent", () => {
    it("should stop an agent", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      expect(agent.status).toBe("creating");

      const stopped = await manager.stopAgent(agent.id, { force: true });
      expect(stopped.status).toBe("stopped");
    });

    it("should be a no-op for already stopped agent", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      await manager.stopAgent(agent.id, { force: true });

      const result = await manager.stopAgent(agent.id);
      expect(result.status).toBe("stopped");
    });

    it("should stop inert agents without invoking tmux", async () => {
      const { runCommand } =
        await import("../../src/shared/lib/run-command.js");
      const inertManager = new AgentManager(pool, noopLogger, inertTestConfig);
      const agent = await inertManager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      vi.mocked(runCommand).mockClear();

      const stopped = await inertManager.stopAgent(agent.id, { force: true });

      expect(stopped.status).toBe("stopped");
      expect(vi.mocked(runCommand)).not.toHaveBeenCalled();
    });
  });

  describe("startAgent", () => {
    async function createStoppedAgent(
      opts: { type?: string; cliSessionId?: string; persona?: string } = {}
    ) {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        type: (opts.type as "claude" | "codex" | "terminal") ?? "claude",
        useWorktree: false,
        cliSessionId: opts.cliSessionId,
        persona: opts.persona,
      });
      await manager.stopAgent(agent.id, { force: true });
      return agent;
    }

    function mockNoSessionThenExists() {
      let launched = false;
      return async (_cmd: string, args: string[]) => {
        if (args[0] === "has-session") {
          if (!launched) return { exitCode: 1, stdout: "", stderr: "" };
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args.includes("new-session")) launched = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      };
    }

    it("should attach to an existing tmux session", async () => {
      const { runCommand } =
        await import("../../src/shared/lib/run-command.js");
      const agent = await createStoppedAgent();

      vi.mocked(runCommand).mockImplementation(
        async (_cmd: string, args: string[]) => {
          if (args[0] === "has-session") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      );

      const started = await manager.startAgent(agent.id);

      expect(started.status).toBe("running");
      expect(started.latestEvent?.message).toBe(
        "Session attached to existing tmux session."
      );
      expect(
        vi
          .mocked(runCommand)
          .mock.calls.some(([, args]) => args?.[0] === "new-session")
      ).toBe(false);
    });

    it("should assign a fresh cliSessionId for legacy claude agents without one", async () => {
      const { runCommand } =
        await import("../../src/shared/lib/run-command.js");
      const agent = await createStoppedAgent({ type: "claude" });

      // Simulate a legacy agent that was created before cliSessionId auto-assignment
      await pool.query(
        "UPDATE agents SET cli_session_id = NULL WHERE id = $1",
        [agent.id]
      );

      vi.mocked(runCommand).mockImplementation(mockNoSessionThenExists());

      const started = await manager.startAgent(agent.id);

      expect(started.status).toBe("running");
      expect(started.cliSessionId).toBeTruthy();
      expect(started.latestEvent?.message).toBe("Session started.");
    });

    it("should resume an existing CLI session when cliSessionId is set", async () => {
      const { runCommand } =
        await import("../../src/shared/lib/run-command.js");
      const sessionId = "11111111-2222-3333-4444-555555555555";
      const agent = await createStoppedAgent({
        type: "claude",
        cliSessionId: sessionId,
      });

      vi.mocked(runCommand).mockImplementation(mockNoSessionThenExists());

      const started = await manager.startAgent(agent.id);

      expect(started.status).toBe("running");
      expect(started.cliSessionId).toBe(sessionId);
      expect(started.latestEvent?.message).toBe("Session resumed.");
    });

    it("should handle race condition on cliSessionId assignment", async () => {
      const { runCommand } =
        await import("../../src/shared/lib/run-command.js");
      const agent = await createStoppedAgent({ type: "claude" });

      // Clear cliSessionId to simulate a legacy agent
      await pool.query(
        "UPDATE agents SET cli_session_id = NULL WHERE id = $1",
        [agent.id]
      );

      // Simulate a concurrent request assigning a cliSessionId between
      // getRequiredAgent (reads null) and the conditional UPDATE
      const raceWinner = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      let injected = false;
      let launched = false;
      vi.mocked(runCommand).mockImplementation(
        async (_cmd: string, args: string[]) => {
          if (args[0] === "has-session") {
            if (!launched) {
              // Before launch: inject the concurrent write
              if (!injected) {
                await pool.query(
                  "UPDATE agents SET cli_session_id = $2 WHERE id = $1",
                  [agent.id, raceWinner]
                );
                injected = true;
              }
              return { exitCode: 1, stdout: "", stderr: "" };
            }
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (args.includes("new-session")) launched = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      );

      const started = await manager.startAgent(agent.id);

      expect(started.status).toBe("running");
      // The conditional UPDATE returns rowCount=0, so it re-fetches
      // and uses the race winner's session ID
      expect(started.cliSessionId).toBe(raceWinner);
    });

    it("should not assign cliSessionId for non-claude agents", async () => {
      const { runCommand } =
        await import("../../src/shared/lib/run-command.js");
      const agent = await createStoppedAgent({ type: "codex" });

      vi.mocked(runCommand).mockImplementation(mockNoSessionThenExists());

      const started = await manager.startAgent(agent.id);

      expect(started.status).toBe("running");
      expect(started.cliSessionId).toBeNull();
      expect(started.latestEvent?.message).toBe("Session started.");
    });

    it("should use terminal-specific event message for terminal agents", async () => {
      const { runCommand } =
        await import("../../src/shared/lib/run-command.js");
      const agent = await createStoppedAgent({ type: "terminal" });

      vi.mocked(runCommand).mockImplementation(mockNoSessionThenExists());

      const started = await manager.startAgent(agent.id);

      expect(started.status).toBe("running");
      expect(started.latestEvent?.message).toBe("Terminal session resumed.");
    });

    it("should set error status when launch fails", async () => {
      const { runCommand } =
        await import("../../src/shared/lib/run-command.js");
      const agent = await createStoppedAgent({ type: "claude" });

      vi.mocked(runCommand).mockImplementation(
        async (_cmd: string, args: string[]) => {
          if (args[0] === "has-session") {
            return { exitCode: 1, stdout: "", stderr: "" };
          }
          if (args.includes("new-session")) {
            throw new Error("tmux not available");
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      );

      await expect(manager.startAgent(agent.id)).rejects.toThrow(
        "Failed to start agent: tmux not available"
      );

      const failed = await manager.getAgent(agent.id);
      expect(failed!.status).toBe("error");
      expect(failed!.lastError).toBe("tmux not available");
      expect(failed!.latestEvent?.type).toBe("blocked");
      expect(failed!.latestEvent?.message).toContain("Failed to start agent");
    });

    it("should skip personality for persona agents even when one is active", async () => {
      const { runCommand } =
        await import("../../src/shared/lib/run-command.js");

      // Set an active personality in the DB
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ('active_personality_id', 'test-personality')
         ON CONFLICT (key) DO UPDATE SET value = 'test-personality'`
      );
      await pool.query(
        `INSERT INTO personalities (id, name, prompt) VALUES ('test-personality', 'Test', 'You are very formal.')
         ON CONFLICT (id) DO UPDATE SET prompt = 'You are very formal.'`
      );

      const agent = await createStoppedAgent({
        type: "claude",
        persona: "security-review",
      });

      const launchCalls: string[][] = [];
      vi.mocked(runCommand).mockImplementation(async (_cmd, args) => {
        if (args[0] === "has-session") {
          if (launchCalls.length === 0)
            return { exitCode: 1, stdout: "", stderr: "" };
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args.includes("new-session")) launchCalls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const started = await manager.startAgent(agent.id);

      expect(started.status).toBe("running");
      expect(launchCalls.length).toBe(1);
      const launchCommand = launchCalls[0]!.join(" ");
      expect(launchCommand).not.toContain("You are very formal.");
    });

    it("should transition through creating state during launch", async () => {
      const { runCommand } =
        await import("../../src/shared/lib/run-command.js");
      const agent = await createStoppedAgent({ type: "claude" });

      const statusesDuringLaunch: string[] = [];
      let launched = false;
      vi.mocked(runCommand).mockImplementation(
        async (_cmd: string, args: string[]) => {
          if (args[0] === "has-session") {
            if (!launched) return { exitCode: 1, stdout: "", stderr: "" };
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (args.includes("new-session")) {
            const mid = await manager.getAgent(agent.id);
            statusesDuringLaunch.push(mid!.status);
            launched = true;
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      );

      await manager.startAgent(agent.id);

      expect(statusesDuringLaunch).toContain("creating");
    });

    it("should include --resume flag in command for resumed sessions", async () => {
      const { runCommand } =
        await import("../../src/shared/lib/run-command.js");
      const sessionId = "22222222-3333-4444-5555-666666666666";
      const agent = await createStoppedAgent({
        type: "claude",
        cliSessionId: sessionId,
      });

      const newSessionArgs: string[][] = [];
      vi.mocked(runCommand).mockImplementation(async (_cmd, args) => {
        if (args[0] === "has-session") {
          if (newSessionArgs.length === 0)
            return { exitCode: 1, stdout: "", stderr: "" };
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args.includes("new-session")) newSessionArgs.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      await manager.startAgent(agent.id);

      expect(newSessionArgs.length).toBe(1);
      const launchCommand = newSessionArgs[0]!.join(" ");
      expect(launchCommand).toContain("--resume");
      expect(launchCommand).toContain(sessionId);
    });

    it("should not include --resume flag for fresh sessions", async () => {
      const { runCommand } =
        await import("../../src/shared/lib/run-command.js");
      const agent = await createStoppedAgent({ type: "claude" });

      // Clear cliSessionId to simulate legacy agent that never had one
      await pool.query(
        "UPDATE agents SET cli_session_id = NULL WHERE id = $1",
        [agent.id]
      );

      const newSessionArgs: string[][] = [];
      vi.mocked(runCommand).mockImplementation(async (_cmd, args) => {
        if (args[0] === "has-session") {
          if (newSessionArgs.length === 0)
            return { exitCode: 1, stdout: "", stderr: "" };
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args.includes("new-session")) newSessionArgs.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      await manager.startAgent(agent.id);

      expect(newSessionArgs.length).toBe(1);
      const launchCommand = newSessionArgs[0]!.join(" ");
      expect(launchCommand).not.toContain("--resume");
    });
  });

  describe("reconcileAgents", () => {
    it("should mark agents as stopped when tmux session is gone", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      await manager.completeSetup(agent.id, {
        effectiveCwd: "/tmp",
        worktreePath: null,
        worktreeBranch: null,
      });

      // Now make tmux report no session
      const { runCommand } =
        await import("../../src/shared/lib/run-command.js");
      const mockRunCommand = vi.mocked(runCommand);
      mockRunCommand.mockImplementation(async (_cmd, args) => {
        if (args[0] === "has-session") {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        if (args[0] === "list-sessions" || args[0] === "list-panes") {
          return { exitCode: 1, stdout: "", stderr: "no server running" };
        }
        if (_cmd === "ps") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (_cmd === "launchctl") {
          return { exitCode: 113, stdout: "", stderr: "service not found" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      await manager.reconcileAgents();

      const reconciled = await manager.getAgent(agent.id);
      expect(reconciled!.status).toBe("stopped");
    });

    it("should surface startup crashes as blocked errors with setup details", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      await writeFile(`/tmp/dispatch_${agent.tmuxSession}.exit`, "EXIT:2");
      await writeFile(
        `/tmp/dispatch_setup_${agent.id}.log`,
        "error: unexpected argument '--append-system-prompt' found\n"
      );

      const { runCommand } =
        await import("../../src/shared/lib/run-command.js");
      const mockRunCommand = vi.mocked(runCommand);
      mockRunCommand.mockImplementation(async (_cmd, args) => {
        if (args[0] === "has-session") {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        if (args[0] === "list-sessions" || args[0] === "list-panes") {
          return { exitCode: 1, stdout: "", stderr: "no server running" };
        }
        if (_cmd === "ps") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (_cmd === "launchctl") {
          return { exitCode: 113, stdout: "", stderr: "service not found" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      await manager.reconcileAgents();

      const reconciled = await manager.getAgent(agent.id);
      expect(reconciled!.status).toBe("error");
      expect(reconciled!.latestEvent?.type).toBe("blocked");
      expect(reconciled!.latestEvent?.message).toContain("Launch failed");
      expect(reconciled!.latestEvent?.message).toContain(
        "unexpected argument '--append-system-prompt'"
      );
      expect(reconciled!.lastError).toContain(
        "unexpected argument '--append-system-prompt'"
      );
    });

    it("should not classify a clean exit as an error from generic stderr text", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      await manager.completeSetup(agent.id, {
        effectiveCwd: "/tmp",
        worktreePath: null,
        worktreeBranch: null,
      });
      await writeFile(`/tmp/dispatch_${agent.tmuxSession}.exit`, "EXIT:0");
      await writeFile(
        `/tmp/dispatch_setup_${agent.id}.log`,
        "warning: previous command printed an error banner\n"
      );

      const { runCommand } =
        await import("../../src/shared/lib/run-command.js");
      const mockRunCommand = vi.mocked(runCommand);
      mockRunCommand.mockImplementation(async (_cmd, args) => {
        if (args[0] === "has-session") {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        if (args[0] === "list-sessions" || args[0] === "list-panes") {
          return { exitCode: 1, stdout: "", stderr: "no server running" };
        }
        if (_cmd === "ps") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (_cmd === "launchctl") {
          return { exitCode: 113, stdout: "", stderr: "service not found" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      await manager.reconcileAgents();

      const reconciled = await manager.getAgent(agent.id);
      expect(reconciled!.status).toBe("stopped");
      expect(reconciled!.latestEvent?.type).toBe("idle");
      expect(reconciled!.latestEvent?.message).toContain(
        "Session ended normally."
      );
      expect(reconciled!.latestEvent?.message).toContain("error banner");
    });

    it("should capture a missing-session diagnostic snapshot", async () => {
      const tempHome = await mkdtemp(
        path.join(os.tmpdir(), "dispatch-agent-manager-home-")
      );
      const previousHome = process.env.HOME;
      process.env.HOME = tempHome;

      try {
        const agent = await manager.createAgent({
          cwd: "/tmp",
          useWorktree: false,
        });

        const { runCommand } =
          await import("../../src/shared/lib/run-command.js");
        const mockRunCommand = vi.mocked(runCommand);
        mockRunCommand.mockClear();
        mockRunCommand.mockImplementation(async (_cmd, args) => {
          if (args[0] === "has-session") {
            return { exitCode: 1, stdout: "", stderr: "" };
          }
          if (args[0] === "list-sessions") {
            return { exitCode: 1, stdout: "", stderr: "no server running" };
          }
          if (args[0] === "list-panes") {
            return { exitCode: 1, stdout: "", stderr: "no server running" };
          }
          if (_cmd === "ps" && args[1] === "pid=,comm=") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (_cmd === "ps") {
            return {
              exitCode: 0,
              stdout: "  PID  PPID  PGID USER COMMAND\n",
              stderr: "",
            };
          }
          if (_cmd === "launchctl") {
            return { exitCode: 0, stdout: "launchctl snapshot", stderr: "" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        });

        await manager.reconcileAgentStatuses();

        const diagnosticsDir = path.join(tempHome, ".dispatch", "diagnostics");
        const files = await readdir(diagnosticsDir);
        const incidentFile = files.find((file) =>
          file.includes(`missing-session-${agent.id}.json`)
        );
        expect(incidentFile).toBeTruthy();

        const incidentRaw = await readFile(
          path.join(diagnosticsDir, incidentFile!),
          "utf-8"
        );
        const incident = JSON.parse(incidentRaw) as {
          incident: string;
          agent: {
            agentId: string;
            tmuxSession: string;
            exitInfo: number | null;
          };
          tmux: { sessions: { exitCode: number; stderr: string } };
          launchctl: { stdout: string };
        };

        expect(incident.incident).toBe("missing_tmux_session");
        expect(incident.agent.agentId).toBe(agent.id);
        expect(incident.agent.tmuxSession).toBe(agent.tmuxSession);
        expect(incident.agent.exitInfo).toBeNull();
        expect(incident.tmux.sessions.exitCode).toBe(1);
        expect(incident.launchctl.stdout).toContain("launchctl snapshot");
      } finally {
        process.env.HOME = previousHome;
        await rm(tempHome, { recursive: true, force: true });
      }
    });
  });

  describe("listFeedbackByParentGrouped", () => {
    it("should only return feedback from the requested parent's children", async () => {
      // Create two parent agents
      const parentA = await manager.createAgent({
        name: "parent-a",
        cwd: "/tmp",
        useWorktree: false,
      });
      const parentB = await manager.createAgent({
        name: "parent-b",
        cwd: "/tmp",
        useWorktree: false,
      });

      // Create persona children for each parent
      const childA = await manager.createAgent({
        name: "child-a",
        cwd: "/tmp",
        useWorktree: false,
        persona: "security-review",
        parentAgentId: parentA.id,
      });
      const childB = await manager.createAgent({
        name: "child-b",
        cwd: "/tmp",
        useWorktree: false,
        persona: "ux-review",
        parentAgentId: parentB.id,
      });

      // Submit feedback from both children
      await manager.submitFeedback(childA.id, {
        severity: "high",
        description: "SQL injection in login handler",
        filePath: "src/auth.ts",
        lineNumber: 42,
      });
      await manager.submitFeedback(childB.id, {
        severity: "low",
        description: "Button color contrast",
        filePath: "src/button.tsx",
      });

      // Parent A should only see child A's feedback
      const resultA = await manager.listFeedbackByParentGrouped(parentA.id);
      expect(resultA.personas).toHaveLength(1);
      expect(resultA.personas[0].persona).toBe("security-review");
      expect(resultA.personas[0].agentId).toBe(childA.id);
      expect(resultA.personas[0].feedback).toHaveLength(1);
      expect(resultA.personas[0].feedback[0].description).toBe(
        "SQL injection in login handler"
      );

      // Parent B should only see child B's feedback
      const resultB = await manager.listFeedbackByParentGrouped(parentB.id);
      expect(resultB.personas).toHaveLength(1);
      expect(resultB.personas[0].persona).toBe("ux-review");
      expect(resultB.personas[0].agentId).toBe(childB.id);
      expect(resultB.personas[0].feedback).toHaveLength(1);
      expect(resultB.personas[0].feedback[0].description).toBe(
        "Button color contrast"
      );
    });

    it("should return empty personas array when agent has no children", async () => {
      const parent = await manager.createAgent({
        name: "lonely-parent",
        cwd: "/tmp",
        useWorktree: false,
      });

      const result = await manager.listFeedbackByParentGrouped(parent.id);
      expect(result.personas).toHaveLength(0);
    });

    it("should filter by persona name", async () => {
      const parent = await manager.createAgent({
        name: "multi-parent",
        cwd: "/tmp",
        useWorktree: false,
      });

      const secChild = await manager.createAgent({
        name: "sec-child",
        cwd: "/tmp",
        useWorktree: false,
        persona: "security-review",
        parentAgentId: parent.id,
      });
      const uxChild = await manager.createAgent({
        name: "ux-child",
        cwd: "/tmp",
        useWorktree: false,
        persona: "ux-review",
        parentAgentId: parent.id,
      });

      await manager.submitFeedback(secChild.id, { description: "sec finding" });
      await manager.submitFeedback(uxChild.id, { description: "ux finding" });

      const filtered = await manager.listFeedbackByParentGrouped(
        parent.id,
        "security-review"
      );
      expect(filtered.personas).toHaveLength(1);
      expect(filtered.personas[0].persona).toBe("security-review");
      expect(filtered.personas[0].feedback[0].description).toBe("sec finding");
    });

    it("should group multiple feedback items under the same persona", async () => {
      const parent = await manager.createAgent({
        name: "parent",
        cwd: "/tmp",
        useWorktree: false,
      });
      const child = await manager.createAgent({
        name: "child",
        cwd: "/tmp",
        useWorktree: false,
        persona: "security-review",
        parentAgentId: parent.id,
      });

      await manager.submitFeedback(child.id, {
        severity: "critical",
        description: "finding 1",
      });
      await manager.submitFeedback(child.id, {
        severity: "low",
        description: "finding 2",
      });

      const result = await manager.listFeedbackByParentGrouped(parent.id);
      expect(result.personas).toHaveLength(1);
      expect(result.personas[0].feedback).toHaveLength(2);
      expect(result.personas[0].feedback[0].description).toBe("finding 1");
      expect(result.personas[0].feedback[1].description).toBe("finding 2");
    });
  });

  describe("updateFeedbackStatusByParent", () => {
    it("should allow a parent to resolve its child's feedback", async () => {
      const parent = await manager.createAgent({
        name: "parent",
        cwd: "/tmp",
        useWorktree: false,
      });
      const child = await manager.createAgent({
        name: "child",
        cwd: "/tmp",
        useWorktree: false,
        persona: "security-review",
        parentAgentId: parent.id,
      });

      const feedback = await manager.submitFeedback(child.id, {
        severity: "high",
        description: "XSS vulnerability",
      });

      const updated = await manager.updateFeedbackStatusByParent(
        feedback.id,
        parent.id,
        "fixed"
      );
      expect(updated).not.toBeNull();
      expect(updated!.id).toBe(feedback.id);
      expect(updated!.status).toBe("fixed");
    });

    it("should return null when parent does not own the child", async () => {
      const parentA = await manager.createAgent({
        name: "parent-a",
        cwd: "/tmp",
        useWorktree: false,
      });
      const parentB = await manager.createAgent({
        name: "parent-b",
        cwd: "/tmp",
        useWorktree: false,
      });
      const child = await manager.createAgent({
        name: "child",
        cwd: "/tmp",
        useWorktree: false,
        persona: "security-review",
        parentAgentId: parentA.id,
      });

      const feedback = await manager.submitFeedback(child.id, {
        description: "finding",
      });

      const result = await manager.updateFeedbackStatusByParent(
        feedback.id,
        parentB.id,
        "ignored",
        { reason: "not my problem" }
      );
      expect(result).toBeNull();
    });

    it("should return null for non-existent feedback id", async () => {
      const parent = await manager.createAgent({
        name: "parent",
        cwd: "/tmp",
        useWorktree: false,
      });

      const result = await manager.updateFeedbackStatusByParent(
        99999,
        parent.id,
        "fixed"
      );
      expect(result).toBeNull();
    });
  });

  // CRU-128 / CRU-130 — resolution capture (reason, resolution_commit,
  // resolved_at, persona_review_resolutions, last_reviewed_commit).
  describe("resolution capture", () => {
    async function seedParentChild() {
      const parent = await manager.createAgent({
        name: "parent",
        cwd: "/tmp",
        useWorktree: false,
      });
      const child = await manager.createAgent({
        name: "child",
        cwd: "/tmp",
        useWorktree: false,
        persona: "security-review",
        parentAgentId: parent.id,
      });
      return { parent, child };
    }

    describe("updateFeedbackStatus (direct)", () => {
      it("rejects ignored without a reason", async () => {
        const { child } = await seedParentChild();
        const feedback = await manager.submitFeedback(child.id, {
          description: "finding",
        });

        await expect(
          feedbackQueries.updateFeedbackStatus(
            pool,
            feedback.id,
            child.id,
            "ignored"
          )
        ).rejects.toThrow(/reason is required/);
      });

      it("rejects ignored with a whitespace-only reason", async () => {
        const { child } = await seedParentChild();
        const feedback = await manager.submitFeedback(child.id, {
          description: "finding",
        });

        await expect(
          feedbackQueries.updateFeedbackStatus(
            pool,
            feedback.id,
            child.id,
            "ignored",
            {
              reason: "   ",
            }
          )
        ).rejects.toThrow(/reason is required/);
      });

      it("persists reason, commit, and resolved_at when ignored with a reason", async () => {
        const { child } = await seedParentChild();
        const feedback = await manager.submitFeedback(child.id, {
          description: "finding",
        });

        const before = Date.now();
        const updated = await feedbackQueries.updateFeedbackStatus(
          pool,
          feedback.id,
          child.id,
          "ignored",
          { reason: "Out of scope", resolutionCommit: "abc1234" }
        );
        const after = Date.now();

        expect(updated).not.toBeNull();
        expect(updated!.status).toBe("ignored");
        expect(updated!.resolutionReason).toBe("Out of scope");
        expect(updated!.resolutionCommit).toBe("abc1234");
        expect(updated!.resolvedAt).toBeTruthy();
        const resolvedMs = new Date(
          updated!.resolvedAt as unknown as string
        ).getTime();
        expect(resolvedMs).toBeGreaterThanOrEqual(before - 1000);
        expect(resolvedMs).toBeLessThanOrEqual(after + 1000);
      });

      it("accepts fixed without a reason and records commit + resolved_at", async () => {
        const { child } = await seedParentChild();
        const feedback = await manager.submitFeedback(child.id, {
          description: "finding",
        });

        const updated = await feedbackQueries.updateFeedbackStatus(
          pool,
          feedback.id,
          child.id,
          "fixed",
          { resolutionCommit: "deadbeef" }
        );

        expect(updated!.status).toBe("fixed");
        expect(updated!.resolutionReason).toBeNull();
        expect(updated!.resolutionCommit).toBe("deadbeef");
        expect(updated!.resolvedAt).toBeTruthy();
      });

      it("persists reason when fixed with a reason", async () => {
        const { child } = await seedParentChild();
        const feedback = await manager.submitFeedback(child.id, {
          description: "finding",
        });

        const updated = await feedbackQueries.updateFeedbackStatus(
          pool,
          feedback.id,
          child.id,
          "fixed",
          { reason: "Patched in request middleware" }
        );

        expect(updated!.status).toBe("fixed");
        expect(updated!.resolutionReason).toBe("Patched in request middleware");
      });

      it("preserves reason on a benign re-resolve with no reason", async () => {
        const { child } = await seedParentChild();
        const feedback = await manager.submitFeedback(child.id, {
          description: "finding",
        });

        await feedbackQueries.updateFeedbackStatus(
          pool,
          feedback.id,
          child.id,
          "ignored",
          {
            reason: "Won't fix",
            resolutionCommit: "sha1",
          }
        );
        // Re-resolve as fixed without passing reason/commit — the original
        // audit trail must be preserved (COALESCE behavior).
        const second = await feedbackQueries.updateFeedbackStatus(
          pool,
          feedback.id,
          child.id,
          "fixed"
        );

        expect(second!.status).toBe("fixed");
        expect(second!.resolutionReason).toBe("Won't fix");
        expect(second!.resolutionCommit).toBe("sha1");
      });

      it("does not drift resolved_at on a benign re-resolve", async () => {
        const { child } = await seedParentChild();
        const feedback = await manager.submitFeedback(child.id, {
          description: "finding",
        });

        const first = await feedbackQueries.updateFeedbackStatus(
          pool,
          feedback.id,
          child.id,
          "fixed"
        );
        const firstResolvedAt = first!.resolvedAt;

        await new Promise((resolve) => setTimeout(resolve, 50));

        const second = await feedbackQueries.updateFeedbackStatus(
          pool,
          feedback.id,
          child.id,
          "ignored",
          { reason: "changed my mind" }
        );

        expect(
          new Date(second!.resolvedAt as unknown as string).getTime()
        ).toBe(new Date(firstResolvedAt as unknown as string).getTime());
      });

      it("clears resolved_at when reverting to open", async () => {
        const { child } = await seedParentChild();
        const feedback = await manager.submitFeedback(child.id, {
          description: "finding",
        });

        await feedbackQueries.updateFeedbackStatus(
          pool,
          feedback.id,
          child.id,
          "fixed"
        );
        const reopened = await feedbackQueries.updateFeedbackStatus(
          pool,
          feedback.id,
          child.id,
          "open"
        );

        expect(reopened!.status).toBe("open");
        expect(reopened!.resolvedAt).toBeNull();
      });
    });

    describe("updateFeedbackStatusByParent (reason validation + commit)", () => {
      it("rejects ignored without a reason", async () => {
        const { parent, child } = await seedParentChild();
        const feedback = await manager.submitFeedback(child.id, {
          description: "finding",
        });

        await expect(
          manager.updateFeedbackStatusByParent(
            feedback.id,
            parent.id,
            "ignored"
          )
        ).rejects.toThrow(/reason is required/);
      });

      it("persists reason and resolution_commit when a parent ignores", async () => {
        const { parent, child } = await seedParentChild();
        const feedback = await manager.submitFeedback(child.id, {
          description: "finding",
        });

        const updated = await manager.updateFeedbackStatusByParent(
          feedback.id,
          parent.id,
          "ignored",
          {
            reason: "Not applicable to this flow",
            resolutionCommit: "f00dbabe",
          }
        );

        expect(updated!.status).toBe("ignored");
        expect(updated!.resolutionReason).toBe("Not applicable to this flow");
        expect(updated!.resolutionCommit).toBe("f00dbabe");
        expect(updated!.resolvedAt).toBeTruthy();
      });

      it("accepts fixed without a reason when parent resolves", async () => {
        const { parent, child } = await seedParentChild();
        const feedback = await manager.submitFeedback(child.id, {
          description: "finding",
        });

        const updated = await manager.updateFeedbackStatusByParent(
          feedback.id,
          parent.id,
          "fixed",
          { resolutionCommit: "cafef00d" }
        );

        expect(updated!.status).toBe("fixed");
        expect(updated!.resolutionCommit).toBe("cafef00d");
        expect(updated!.resolvedAt).toBeTruthy();
      });
    });

    describe("submitReviewResolution", () => {
      async function seedCompletedReview(): Promise<{
        parent: Awaited<ReturnType<typeof manager.createAgent>>;
        child: Awaited<ReturnType<typeof manager.createAgent>>;
      }> {
        const { parent, child } = await seedParentChild();
        await manager.createPersonaReview({
          agentId: child.id,
          parentAgentId: parent.id,
          persona: "security-review",
          lastReviewedCommit: "launchsha",
        });
        await manager.completePersonaReview(child.id, {
          verdict: "approve",
          summary: "All good",
        });
        return { parent, child };
      }

      async function seedCompletedReviewWithRecheck(): Promise<{
        parent: Awaited<ReturnType<typeof manager.createAgent>>;
        child: Awaited<ReturnType<typeof manager.createAgent>>;
      }> {
        const { parent, child } = await seedParentChild();
        await manager.createPersonaReview({
          agentId: child.id,
          parentAgentId: parent.id,
          persona: "security-review",
          lastReviewedCommit: "launchsha",
        });
        await manager.completePersonaReview(child.id, {
          verdict: "approve",
          summary: "All good",
          lastReviewedCommit: "round1sha",
        });
        return { parent, child };
      }

      it("rejects an empty summary", async () => {
        const { parent, child } = await seedCompletedReview();

        await expect(
          manager.submitReviewResolution({
            parentAgentId: parent.id,
            personaAgentId: child.id,
            summary: "",
          })
        ).rejects.toThrow(/summary is required/);
      });

      it("rejects a whitespace-only summary", async () => {
        const { parent, child } = await seedCompletedReview();

        await expect(
          manager.submitReviewResolution({
            parentAgentId: parent.id,
            personaAgentId: child.id,
            summary: "   \n\t ",
          })
        ).rejects.toThrow(/summary is required/);
      });

      it("rejects a summary above the 10,000 character limit", async () => {
        const { parent, child } = await seedCompletedReview();

        await expect(
          manager.submitReviewResolution({
            parentAgentId: parent.id,
            personaAgentId: child.id,
            summary: "x".repeat(10_001),
          })
        ).rejects.toThrow(/10,000 character/);
      });

      it("rejects when the review is not in 'complete' state", async () => {
        const { parent, child } = await seedParentChild();
        // Create but do NOT complete the review — status stays 'reviewing'.
        await manager.createPersonaReview({
          agentId: child.id,
          parentAgentId: parent.id,
          persona: "security-review",
        });

        await expect(
          manager.submitReviewResolution({
            parentAgentId: parent.id,
            personaAgentId: child.id,
            summary: "Addressed everything",
          })
        ).rejects.toThrow(/must be in status 'complete'/);
      });

      it("rejects when there are still open feedback items", async () => {
        const { parent, child } = await seedCompletedReview();
        const openItem = await manager.submitFeedback(child.id, {
          description: "unresolved",
        });
        // Also add a resolved item to confirm only the open ones are reported.
        const fixedItem = await manager.submitFeedback(child.id, {
          description: "done",
        });
        await feedbackQueries.updateFeedbackStatus(
          pool,
          fixedItem.id,
          child.id,
          "fixed"
        );

        const err = await manager
          .submitReviewResolution({
            parentAgentId: parent.id,
            personaAgentId: child.id,
            summary: "Addressed some",
          })
          .catch((e: unknown) => e as Error);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain(
          `feedback items still open: ${openItem.id}`
        );
        // Recovery hint — tells a fresh agent exactly which tool to call.
        expect((err as Error).message).toContain(
          "Call dispatch_resolve_feedback"
        );
        expect((err as Error).message).toContain("status 'fixed' or 'ignored'");
      });

      it("rejects when an ignored item is missing a reason", async () => {
        const { parent, child } = await seedCompletedReview();
        const item = await manager.submitFeedback(child.id, {
          description: "maybe later",
        });
        // Insert a bare 'ignored' row directly — bypass the resolve API guard
        // to prove submitReviewResolution enforces the reason rule itself.
        await pool.query(
          "UPDATE agent_feedback SET status = 'ignored', resolution_reason = NULL WHERE id = $1",
          [item.id]
        );

        const err = await manager
          .submitReviewResolution({
            parentAgentId: parent.id,
            personaAgentId: child.id,
            summary: "Covered the rest",
          })
          .catch((e: unknown) => e as Error);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain(
          `ignored feedback items missing a reason: ${item.id}`
        );
        // Recovery hint — points at the right tool with the right status.
        expect((err as Error).message).toContain(
          "Call dispatch_resolve_feedback"
        );
        expect((err as Error).message).toContain("status 'ignored'");
        expect((err as Error).message).toContain(
          "reason explaining why it was not addressed"
        );
      });

      it("returns 404 when there is no review for the parent/child pair", async () => {
        const { parent, child } = await seedParentChild();
        // No createPersonaReview call.

        await expect(
          manager.submitReviewResolution({
            parentAgentId: parent.id,
            personaAgentId: child.id,
            summary: "nothing to resolve against",
          })
        ).rejects.toThrow(/No persona review found/);
      });

      it("persists summary and resolution_commit on the happy path", async () => {
        const { parent, child } = await seedCompletedReviewWithRecheck();
        const item = await manager.submitFeedback(child.id, {
          description: "a thing",
        });
        await feedbackQueries.updateFeedbackStatus(
          pool,
          item.id,
          child.id,
          "ignored",
          {
            reason: "rejected by design",
          }
        );

        const result = await manager.submitReviewResolution({
          parentAgentId: parent.id,
          personaAgentId: child.id,
          summary: "Accepted one, rejected one.",
          resolutionCommit: "headsha1",
        });

        expect(result.resolution.summary).toBe("Accepted one, rejected one.");
        expect(result.resolution.resolutionCommit).toBe("headsha1");
        expect(result.resolution.roundNumber).toBe(1);
        expect(result.review.status).toBe("awaiting_recheck");

        // Confirm via a separate read path so the test also covers read APIs.
        const resolutions = await manager.getReviewResolutions(
          result.review.id
        );
        expect(resolutions).toHaveLength(1);
        expect(resolutions[0].summary).toBe("Accepted one, rejected one.");
        expect(resolutions[0].resolutionCommit).toBe("headsha1");
      });

      it("transitions reviews to awaiting_recheck after resolution submission", async () => {
        const { parent, child } = await seedCompletedReview();

        const result = await manager.submitReviewResolution({
          parentAgentId: parent.id,
          personaAgentId: child.id,
          summary: "Recorded the resolution for recheck.",
          resolutionCommit: "headsha1",
        });

        expect(result.review.status).toBe("awaiting_recheck");
      });

      it("rejects repeat submit once the review is awaiting_recheck", async () => {
        const { parent, child } = await seedCompletedReviewWithRecheck();

        await manager.submitReviewResolution({
          parentAgentId: parent.id,
          personaAgentId: child.id,
          summary: "v1",
          resolutionCommit: "sha-v1",
        });

        await expect(
          manager.submitReviewResolution({
            parentAgentId: parent.id,
            personaAgentId: child.id,
            summary: "v2 — revised",
            resolutionCommit: "sha-v2",
          })
        ).rejects.toThrow(/already awaiting recheck/);
      });

      it("trims leading/trailing whitespace from the stored summary", async () => {
        const { parent, child } = await seedCompletedReview();

        const result = await manager.submitReviewResolution({
          parentAgentId: parent.id,
          personaAgentId: child.id,
          summary: "   padded summary   \n",
        });

        expect(result.resolution.summary).toBe("padded summary");
      });

      it("does not persist any resolution when a precondition fails", async () => {
        const { parent, child } = await seedCompletedReview();
        await manager.submitFeedback(child.id, { description: "still open" });

        await expect(
          manager.submitReviewResolution({
            parentAgentId: parent.id,
            personaAgentId: child.id,
            summary: "optimistic",
          })
        ).rejects.toThrow();

        const review = await manager.getPersonaReview(child.id);
        const resolutions = await manager.getReviewResolutions(review!.id);
        expect(resolutions).toHaveLength(0);
      });
    });

    describe("persona review last_reviewed_commit", () => {
      it("stores the launch commit on createPersonaReview", async () => {
        const { parent, child } = await seedParentChild();

        const review = await manager.createPersonaReview({
          agentId: child.id,
          parentAgentId: parent.id,
          persona: "security-review",
          lastReviewedCommit: "launchsha",
        });

        expect(review.lastReviewedCommit).toBe("launchsha");
        const refetched = await manager.getPersonaReview(child.id);
        expect(refetched!.lastReviewedCommit).toBe("launchsha");
      });

      it("defaults to null when no commit is supplied at launch", async () => {
        const { parent, child } = await seedParentChild();

        const review = await manager.createPersonaReview({
          agentId: child.id,
          parentAgentId: parent.id,
          persona: "security-review",
        });

        expect(review.lastReviewedCommit).toBeNull();
      });

      it("updates last_reviewed_commit on completePersonaReview", async () => {
        const { parent, child } = await seedParentChild();
        await manager.createPersonaReview({
          agentId: child.id,
          parentAgentId: parent.id,
          persona: "security-review",
          lastReviewedCommit: "launchsha",
        });

        const completed = await manager.completePersonaReview(child.id, {
          verdict: "approve",
          summary: "fine",
          lastReviewedCommit: "completesha",
        });

        expect(completed.lastReviewedCommit).toBe("completesha");
      });

      it("preserves last_reviewed_commit via COALESCE when completion omits it", async () => {
        const { parent, child } = await seedParentChild();
        await manager.createPersonaReview({
          agentId: child.id,
          parentAgentId: parent.id,
          persona: "security-review",
          lastReviewedCommit: "launchsha",
        });

        const completed = await manager.completePersonaReview(child.id, {
          verdict: "approve",
          summary: "fine",
          // no lastReviewedCommit
        });

        expect(completed.lastReviewedCommit).toBe("launchsha");
      });
    });

    describe("round-trip review state machine", () => {
      async function seedCompletedReview(): Promise<{
        parent: Awaited<ReturnType<typeof manager.createAgent>>;
        child: Awaited<ReturnType<typeof manager.createAgent>>;
      }> {
        const { parent, child } = await seedParentChild();
        await manager.createPersonaReview({
          agentId: child.id,
          parentAgentId: parent.id,
          persona: "security-review",
          lastReviewedCommit: "launchsha",
        });
        await manager.completePersonaReview(child.id, {
          verdict: "approve",
          summary: "All good",
        });
        return { parent, child };
      }

      async function seedCompletedReviewWithRecheck(): Promise<{
        parent: Awaited<ReturnType<typeof manager.createAgent>>;
        child: Awaited<ReturnType<typeof manager.createAgent>>;
      }> {
        const { parent, child } = await seedParentChild();
        await manager.createPersonaReview({
          agentId: child.id,
          parentAgentId: parent.id,
          persona: "security-review",
          lastReviewedCommit: "launchsha",
        });
        await manager.completePersonaReview(child.id, {
          verdict: "approve",
          summary: "All good",
          lastReviewedCommit: "round1sha",
        });
        return { parent, child };
      }

      async function seedAwaitingRecheckReview() {
        const { parent, child } = await seedCompletedReviewWithRecheck();
        const original = await manager.submitFeedback(child.id, {
          description: "round 1 finding",
          severity: "high",
          filePath: "apps/server/src/server.ts",
          lineNumber: 42,
        });
        await feedbackQueries.updateFeedbackStatus(
          pool,
          original.id,
          child.id,
          "fixed",
          {
            reason: "patched",
            resolutionCommit: "fixsha",
          }
        );
        await manager.submitReviewResolution({
          parentAgentId: parent.id,
          personaAgentId: child.id,
          summary: "Patched the finding.",
          resolutionCommit: "parentsha",
        });
        return { parent, child, original };
      }

      it("allows round 2 completion from awaiting_recheck and increments round_number", async () => {
        const { child } = await seedAwaitingRecheckReview();

        const completed = await manager.completePersonaReview(child.id, {
          verdict: "approve",
          summary: "Round 2 complete",
          lastReviewedCommit: "round2sha",
        });

        expect(completed.status).toBe("complete");
        expect(completed.roundNumber).toBe(2);
        expect(completed.lastReviewedCommit).toBe("round2sha");
      });

      it("rejects a third completion attempt in v1", async () => {
        const { child } = await seedAwaitingRecheckReview();
        await manager.completePersonaReview(child.id, {
          verdict: "approve",
          summary: "Round 2 complete",
        });

        const err = await manager
          .completePersonaReview(child.id, {
            verdict: "approve",
            summary: "Round 3",
          })
          .catch((e: unknown) => e as Error);
        expect(err).toBeInstanceOf(Error);
        // Ticket-spec copy — the rejection itself is guidance, so lock it in.
        expect((err as Error).message).toBe(
          "Round 2 already complete. This review only supports a single round-trip."
        );
      });

      it("listResolvedFeedbackForRound returns the per-item resolutions for a round", async () => {
        const { child, original } = await seedAwaitingRecheckReview();

        const items = await manager.listResolvedFeedbackForRound(child.id, 1);

        expect(items).toEqual([
          expect.objectContaining({
            feedbackId: original.id,
            originalDescription: "round 1 finding",
            originalSeverity: "high",
            status: "fixed",
            reason: "patched",
            filePath: "apps/server/src/server.ts",
            lineNumber: 42,
            resolutionCommit: "fixsha",
            roundNumber: 1,
          }),
        ]);
      });

      it("countFeedbackForAgent returns the total feedback count for an agent", async () => {
        const { child } = await seedAwaitingRecheckReview();
        await manager.submitFeedback(child.id, {
          description: "round 2 follow-up",
        });

        await expect(manager.countFeedbackForAgent(child.id)).resolves.toBe(2);
      });

      it("cancels recheck from the parent and rejects cancelling after round 2 completes", async () => {
        const { parent, child } = await seedAwaitingRecheckReview();

        const result = await manager.cancelReviewRecheck({
          parentAgentId: parent.id,
          personaAgentId: child.id,
          reason: "shipping without recheck",
        });
        expect(result.transitioned).toBe(true);
        expect(result.review.status).toBe("cancelled");
        expect(result.review.message).toBe("shipping without recheck");

        const { parent: parent2, child: child2 } =
          await seedAwaitingRecheckReview();
        await manager.completePersonaReview(child2.id, {
          verdict: "approve",
          summary: "Round 2 complete",
        });

        await expect(
          manager.cancelReviewRecheck({
            parentAgentId: parent2.id,
            personaAgentId: child2.id,
          })
        ).rejects.toThrow(/after round 2 is already complete/);
      });

      it("returns transitioned: false when called on an already-cancelled review", async () => {
        const { parent, child } = await seedAwaitingRecheckReview();

        const first = await manager.cancelReviewRecheck({
          parentAgentId: parent.id,
          personaAgentId: child.id,
          reason: "first",
        });
        expect(first.transitioned).toBe(true);

        const second = await manager.cancelReviewRecheck({
          parentAgentId: parent.id,
          personaAgentId: child.id,
          reason: "second",
        });
        expect(second.transitioned).toBe(false);
        expect(second.review.status).toBe("cancelled");
        // Original cancellation reason is preserved — second call is a no-op.
        expect(second.review.message).toBe("first");
      });

      it("rejects cancelling while round 1 review is still in progress", async () => {
        const { parent, child } = await seedParentChild();
        await manager.createPersonaReview({
          agentId: child.id,
          parentAgentId: parent.id,
          persona: "security-review",
          lastReviewedCommit: "launchsha",
        });

        await expect(
          manager.cancelReviewRecheck({
            parentAgentId: parent.id,
            personaAgentId: child.id,
          })
        ).rejects.toThrow(/can only be cancelled while awaiting/i);
      });

      it("records round 2 findings with round_number = 2", async () => {
        const { child } = await seedAwaitingRecheckReview();

        const round2Feedback = await manager.submitFeedback(child.id, {
          description: "round 2 follow-up",
        });

        expect(round2Feedback.roundNumber).toBe(2);
      });

      it("persists respondsToFeedbackId on round 2 follow-up findings", async () => {
        const { child, original } = await seedAwaitingRecheckReview();

        const round2Feedback = await manager.submitFeedback(child.id, {
          description: "round 2 follow-up",
          respondsToFeedbackId: original.id,
        });

        expect(round2Feedback.roundNumber).toBe(2);
        expect(round2Feedback.respondsToFeedbackId).toBe(original.id);
      });

      it("rejects respondsToFeedbackId that belongs to a different review", async () => {
        const { child } = await seedAwaitingRecheckReview();
        const { child: otherChild } = await seedAwaitingRecheckReview();
        const foreignOriginal = await manager.submitFeedback(otherChild.id, {
          description: "other reviewer's finding",
        });

        await expect(
          manager.submitFeedback(child.id, {
            description: "cross-linked follow-up",
            respondsToFeedbackId: foreignOriginal.id,
          })
        ).rejects.toThrow(/different review/i);
      });

      it("rejects respondsToFeedbackId that points at a non-existent feedback", async () => {
        const { child } = await seedAwaitingRecheckReview();

        await expect(
          manager.submitFeedback(child.id, {
            description: "pointing at a ghost",
            respondsToFeedbackId: 999999,
          })
        ).rejects.toThrow(/not found/i);
      });

      it("rejects respondsToFeedbackId that points at a round-2 finding", async () => {
        const { child, original } = await seedAwaitingRecheckReview();
        const round2 = await manager.submitFeedback(child.id, {
          description: "round 2 follow-up",
          respondsToFeedbackId: original.id,
        });
        // Putting the review back into awaiting_recheck is complex; instead
        // verify the round-number guard by attempting to respond to a
        // round-2 item directly, which should be rejected.
        await expect(
          manager.submitFeedback(child.id, {
            description: "chain to a round-2 item",
            respondsToFeedbackId: round2.id,
          })
        ).rejects.toThrow(/round-1/i);
      });

      it("updatePersonaReviewStatus rejects a ping on a completed review with a specific 409", async () => {
        const { child } = await seedCompletedReview();

        const err = await manager
          .updatePersonaReviewStatus(child.id, {
            status: "reviewing",
            message: "late ping",
          })
          .catch((e: unknown) => e as Error);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain(
          "Cannot ping review_status on a complete review"
        );
      });

      it("updatePersonaReviewStatus rejects a ping on a cancelled review with a specific 409", async () => {
        const { parent, child } = await seedAwaitingRecheckReview();
        await manager.cancelReviewRecheck({
          parentAgentId: parent.id,
          personaAgentId: child.id,
          reason: "aborted",
        });

        const err = await manager
          .updatePersonaReviewStatus(child.id, {
            status: "reviewing",
            message: "ping after cancel",
          })
          .catch((e: unknown) => e as Error);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain(
          "Cannot ping review_status on a cancelled review"
        );
      });

      it("review_status('reviewing') does not clobber 'awaiting_recheck' during round 2 (dogfood regression)", async () => {
        // Regression: if review_status overwrote awaiting_recheck back
        // to 'reviewing', the next completePersonaReview would be
        // treated as round 1 and round_number would stick at 1 even
        // though the reviewer just finished round 2. See CRU-133
        // end-to-end dogfood.
        const { child } = await seedAwaitingRecheckReview();

        await manager.updatePersonaReviewStatus(child.id, {
          status: "reviewing",
          message: "Starting round 2",
        });

        const stillAwaiting = await manager.getPersonaReview(child.id);
        expect(stillAwaiting!.status).toBe("awaiting_recheck");
        expect(stillAwaiting!.message).toBe("Starting round 2");

        const completed = await manager.completePersonaReview(child.id, {
          verdict: "approve",
          summary: "Round 2 done",
        });
        expect(completed.status).toBe("complete");
        expect(completed.roundNumber).toBe(2);
      });

      it("completePersonaReview recovers from a 'reviewing' status after a prior resolution (defense-in-depth)", async () => {
        // Even if something upstream did downgrade the status to
        // 'reviewing' after a round-1 resolution, the completion path
        // must still land as round 2 — it infers the round from the
        // submitted resolution, not just the current status label.
        const { child } = await seedAwaitingRecheckReview();

        // Force the buggy intermediate state directly.
        await pool.query(
          "UPDATE persona_reviews SET status = 'reviewing' WHERE agent_id = $1",
          [child.id]
        );

        const completed = await manager.completePersonaReview(child.id, {
          verdict: "approve",
          summary: "Round 2 done despite the detour",
        });
        expect(completed.status).toBe("complete");
        expect(completed.roundNumber).toBe(2);
      });
    });
  });

  describe("listRecentPersonaReviews", () => {
    it("should return reviews created within the time window", async () => {
      const parent = await manager.createAgent({
        name: "parent",
        cwd: "/tmp",
        useWorktree: false,
      });
      const child = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
        persona: "security-review",
        parentAgentId: parent.id,
      });

      await manager.createPersonaReview({
        agentId: child.id,
        parentAgentId: parent.id,
        persona: "security-review",
      });
      await manager.completePersonaReview(child.id, {
        verdict: "approve",
        summary: "Looks good",
      });

      const reviews = await personaReviewQueries.listRecentPersonaReviews(
        pool,
        7
      );
      expect(reviews.length).toBeGreaterThanOrEqual(1);
      const review = reviews.find((r) => r.agentId === child.id);
      expect(review).toBeDefined();
      expect(review!.persona).toBe("security-review");
      expect(review!.verdict).toBe("approve");
      expect(review!.summary).toBe("Looks good");
    });

    it("should return empty array when no reviews exist in the window", async () => {
      const reviews = await personaReviewQueries.listRecentPersonaReviews(
        pool,
        7
      );
      expect(reviews).toEqual([]);
    });
  });

  describe("listRecentFeedback", () => {
    it("should return feedback with persona info within the time window", async () => {
      const parent = await manager.createAgent({
        name: "parent",
        cwd: "/tmp",
        useWorktree: false,
      });
      const child = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
        persona: "security-review",
        parentAgentId: parent.id,
      });

      await manager.submitFeedback(child.id, {
        severity: "high",
        description: "SQL injection risk",
        filePath: "src/db.ts",
        lineNumber: 10,
      });
      await manager.submitFeedback(child.id, {
        severity: "low",
        description: "Minor style issue",
      });

      const feedback = await feedbackQueries.listRecentFeedback(pool, 7);
      expect(feedback.length).toBeGreaterThanOrEqual(2);
      const items = feedback.filter((f) => f.agentId === child.id);
      expect(items).toHaveLength(2);
      expect(items[0].persona).toBe("security-review");
      expect(items[0].severity).toBe("high");
      expect(items[0].description).toBe("SQL injection risk");
      expect(items[1].severity).toBe("low");
    });

    it("should return empty array when no feedback exists in the window", async () => {
      const feedback = await feedbackQueries.listRecentFeedback(pool, 7);
      expect(feedback).toEqual([]);
    });
  });

  describe("cliSessionId", () => {
    it("should store cliSessionId when provided at creation", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
        cliSessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      });

      expect(agent.cliSessionId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    });

    it("should default cliSessionId to null", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      expect(agent.cliSessionId).toBeNull();
    });

    it("should persist cliSessionId for persona agents", async () => {
      const parent = await manager.createAgent({
        name: "parent",
        cwd: "/tmp",
        useWorktree: false,
      });
      const persona = await manager.createAgent({
        name: "sec-review",
        cwd: "/tmp",
        useWorktree: false,
        persona: "security-review",
        parentAgentId: parent.id,
        cliSessionId: "11111111-2222-3333-4444-555555555555",
      });

      // Re-fetch to verify persistence
      const fetched = await manager.getAgent(persona.id);
      expect(fetched!.cliSessionId).toBe(
        "11111111-2222-3333-4444-555555555555"
      );
      expect(fetched!.parentAgentId).toBe(parent.id);
    });
  });

  describe("harvestAgentTokens", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(path.join(os.tmpdir(), "harvest-mgr-test-"));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("should harvest only the persona's session for a persona agent", async () => {
      const { cwdToClaudeProjectDir } =
        await import("../../src/agents/token-harvester.js");
      const { mkdir, writeFile } = await import("node:fs/promises");

      const projectDir = cwdToClaudeProjectDir(tmpDir);
      await mkdir(projectDir, { recursive: true });

      const parentSessionId = "parent-sess-aaa";
      const personaSessionId = "persona-sess-bbb";

      const makeEntry = (tokens: number) =>
        JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-opus-4-6",
            usage: { input_tokens: tokens, output_tokens: 10 },
          },
          timestamp: "2026-04-01T10:00:00.000Z",
        });

      await writeFile(
        path.join(projectDir, `${parentSessionId}.jsonl`),
        makeEntry(1000) + "\n"
      );
      await writeFile(
        path.join(projectDir, `${personaSessionId}.jsonl`),
        makeEntry(200) + "\n"
      );

      // Create parent + persona agents sharing the same cwd
      const parent = await manager.createAgent({
        name: "parent",
        type: "claude",
        cwd: tmpDir,
        useWorktree: false,
      });
      const persona = await manager.createAgent({
        name: "sec-persona",
        type: "claude",
        cwd: tmpDir,
        useWorktree: false,
        persona: "security-review",
        parentAgentId: parent.id,
        cliSessionId: personaSessionId,
      });

      // Harvest for persona — should only get its own 200 tokens
      await manager.harvestAgentTokens(persona);

      const personaUsage = await pool.query(
        `SELECT SUM(input_tokens)::int AS total FROM agent_token_usage WHERE agent_id = $1`,
        [persona.id]
      );
      expect(personaUsage.rows[0].total).toBe(200);

      // Verify parent's session was NOT harvested under persona
      const personaSessions = await pool.query(
        `SELECT session_id FROM agent_token_usage WHERE agent_id = $1`,
        [persona.id]
      );
      expect(personaSessions.rows).toHaveLength(1);
      expect(personaSessions.rows[0].session_id).toBe(personaSessionId);

      await rm(projectDir, { recursive: true, force: true });
    });

    it("should exclude persona sessions when harvesting the parent agent", async () => {
      const { cwdToClaudeProjectDir } =
        await import("../../src/agents/token-harvester.js");
      const { mkdir, writeFile } = await import("node:fs/promises");

      const projectDir = cwdToClaudeProjectDir(tmpDir);
      await mkdir(projectDir, { recursive: true });

      const personaSessionId = "persona-sess-ddd";

      const makeEntry = (tokens: number) =>
        JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-opus-4-6",
            usage: { input_tokens: tokens, output_tokens: 10 },
          },
          timestamp: "2026-04-01T10:00:00.000Z",
        });

      // Create parent — it auto-generates a cliSessionId
      const parent = await manager.createAgent({
        name: "parent",
        type: "claude",
        cwd: tmpDir,
        useWorktree: false,
      });

      // Create session files using the parent's auto-generated session ID
      await writeFile(
        path.join(projectDir, `${parent.cliSessionId}.jsonl`),
        makeEntry(800) + "\n"
      );
      await writeFile(
        path.join(projectDir, `${personaSessionId}.jsonl`),
        makeEntry(150) + "\n"
      );

      await manager.createAgent({
        name: "persona-child",
        type: "claude",
        cwd: tmpDir,
        useWorktree: false,
        persona: "security-review",
        parentAgentId: parent.id,
        cliSessionId: personaSessionId,
      });

      // Harvest for parent — should only get its own 800 tokens
      await manager.harvestAgentTokens(parent);

      const parentUsage = await pool.query(
        `SELECT SUM(input_tokens)::int AS total FROM agent_token_usage WHERE agent_id = $1`,
        [parent.id]
      );
      expect(parentUsage.rows[0].total).toBe(800);

      const parentSessions = await pool.query(
        `SELECT session_id FROM agent_token_usage WHERE agent_id = $1`,
        [parent.id]
      );
      expect(parentSessions.rows).toHaveLength(1);
      expect(parentSessions.rows[0].session_id).toBe(parent.cliSessionId);

      await rm(projectDir, { recursive: true, force: true });
    });

    it("should handle parent with multiple personas — each only gets its own session", async () => {
      const { cwdToClaudeProjectDir } =
        await import("../../src/agents/token-harvester.js");
      const { mkdir, writeFile } = await import("node:fs/promises");

      const projectDir = cwdToClaudeProjectDir(tmpDir);
      await mkdir(projectDir, { recursive: true });

      const persona1SessionId = "persona1-sess-fff";
      const persona2SessionId = "persona2-sess-ggg";

      const makeEntry = (tokens: number) =>
        JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-opus-4-6",
            usage: { input_tokens: tokens, output_tokens: 10 },
          },
          timestamp: "2026-04-01T10:00:00.000Z",
        });

      const parent = await manager.createAgent({
        name: "parent",
        type: "claude",
        cwd: tmpDir,
        useWorktree: false,
      });

      await writeFile(
        path.join(projectDir, `${parent.cliSessionId}.jsonl`),
        makeEntry(500) + "\n"
      );
      await writeFile(
        path.join(projectDir, `${persona1SessionId}.jsonl`),
        makeEntry(100) + "\n"
      );
      await writeFile(
        path.join(projectDir, `${persona2SessionId}.jsonl`),
        makeEntry(75) + "\n"
      );

      await manager.createAgent({
        name: "sec-persona",
        type: "claude",
        cwd: tmpDir,
        useWorktree: false,
        persona: "security-review",
        parentAgentId: parent.id,
        cliSessionId: persona1SessionId,
      });
      await manager.createAgent({
        name: "ux-persona",
        type: "claude",
        cwd: tmpDir,
        useWorktree: false,
        persona: "ux-review",
        parentAgentId: parent.id,
        cliSessionId: persona2SessionId,
      });

      // Parent only gets its own session
      await manager.harvestAgentTokens(parent);

      const parentSessions = await pool.query(
        `SELECT session_id FROM agent_token_usage WHERE agent_id = $1`,
        [parent.id]
      );
      expect(parentSessions.rows).toHaveLength(1);
      expect(parentSessions.rows[0].session_id).toBe(parent.cliSessionId);

      await rm(projectDir, { recursive: true, force: true });
    });

    it("should harvest only the agent's own session file", async () => {
      const { cwdToClaudeProjectDir } =
        await import("../../src/agents/token-harvester.js");
      const { mkdir, writeFile } = await import("node:fs/promises");

      const projectDir = cwdToClaudeProjectDir(tmpDir);
      await mkdir(projectDir, { recursive: true });

      const makeEntry = (tokens: number) =>
        JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-opus-4-6",
            usage: { input_tokens: tokens, output_tokens: 10 },
          },
          timestamp: "2026-04-01T10:00:00.000Z",
        });

      const agent = await manager.createAgent({
        name: "solo-agent",
        type: "claude",
        cwd: tmpDir,
        useWorktree: false,
      });

      // Create the agent's session file and an unrelated one
      await writeFile(
        path.join(projectDir, `${agent.cliSessionId}.jsonl`),
        makeEntry(300) + "\n"
      );
      await writeFile(
        path.join(projectDir, "unrelated-session.jsonl"),
        makeEntry(400) + "\n"
      );

      await manager.harvestAgentTokens(agent);

      const usage = await pool.query(
        `SELECT SUM(input_tokens)::int AS total FROM agent_token_usage WHERE agent_id = $1`,
        [agent.id]
      );
      expect(usage.rows[0].total).toBe(300); // Only the agent's own session

      const sessions = await pool.query(
        `SELECT session_id FROM agent_token_usage WHERE agent_id = $1`,
        [agent.id]
      );
      expect(sessions.rows).toHaveLength(1);
      expect(sessions.rows[0].session_id).toBe(agent.cliSessionId);

      await rm(projectDir, { recursive: true, force: true });
    });

    it("should ignore unrelated and persona sessions in the same project dir", async () => {
      const { cwdToClaudeProjectDir } =
        await import("../../src/agents/token-harvester.js");
      const { mkdir, writeFile } = await import("node:fs/promises");

      const projectDir = cwdToClaudeProjectDir(tmpDir);
      await mkdir(projectDir, { recursive: true });

      const personaSessionId = "persona-sess-hhh";

      const makeEntry = (tokens: number) =>
        JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-opus-4-6",
            usage: { input_tokens: tokens, output_tokens: 10 },
          },
          timestamp: "2026-04-01T10:00:00.000Z",
        });

      const parent = await manager.createAgent({
        name: "parent",
        type: "claude",
        cwd: tmpDir,
        useWorktree: false,
      });

      // Create parent's session, a persona session, and an unrelated old session
      await writeFile(
        path.join(projectDir, `${parent.cliSessionId}.jsonl`),
        makeEntry(300) + "\n"
      );
      await writeFile(
        path.join(projectDir, `${personaSessionId}.jsonl`),
        makeEntry(50) + "\n"
      );
      await writeFile(
        path.join(projectDir, "old-unrelated.jsonl"),
        makeEntry(999) + "\n"
      );

      await manager.createAgent({
        name: "persona",
        type: "claude",
        cwd: tmpDir,
        useWorktree: false,
        persona: "security-review",
        parentAgentId: parent.id,
        cliSessionId: personaSessionId,
      });

      // Parent should only get its own session — not persona's, not unrelated
      await manager.harvestAgentTokens(parent);

      const parentUsage = await pool.query(
        `SELECT SUM(input_tokens)::int AS total FROM agent_token_usage WHERE agent_id = $1`,
        [parent.id]
      );
      expect(parentUsage.rows[0].total).toBe(300);

      const parentSessions = await pool.query(
        `SELECT session_id FROM agent_token_usage WHERE agent_id = $1`,
        [parent.id]
      );
      expect(parentSessions.rows).toHaveLength(1);
      expect(parentSessions.rows[0].session_id).toBe(parent.cliSessionId);

      await rm(projectDir, { recursive: true, force: true });
    });

    it("should skip session ownership logic for non-claude agents", async () => {
      const agent = await manager.createAgent({
        name: "codex-agent",
        type: "codex",
        cwd: "/tmp",
        useWorktree: false,
      });

      // Should not throw — codex agents don't use session ownership
      await manager.harvestAgentTokens(agent);

      // No Claude project dir exists, so no tokens harvested (codex uses a different path)
      const usage = await pool.query(
        `SELECT COUNT(*)::int AS count FROM agent_token_usage WHERE agent_id = $1`,
        [agent.id]
      );
      expect(usage.rows[0].count).toBe(0);
    });
  });

  describe("listMedia", () => {
    it("should include filePath and sizeBytes for each media item", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await pool.query(
        `INSERT INTO media (agent_id, file_name, source, size_bytes, description)
         VALUES ($1, 'doc.pdf', 'upload', 4096, 'Product brief')`,
        [agent.id]
      );

      const media = await manager.listMedia(agent.id);
      expect(media).toHaveLength(1);
      const item = media[0]!;
      expect(item.fileName).toBe("doc.pdf");
      expect(item.description).toBe("Product brief");
      expect(item.source).toBe("upload");
      expect(item.sizeBytes).toBe(4096);
      expect(typeof item.createdAt).toBe("string");
      expect(item.filePath.endsWith(`${agent.id}/doc.pdf`)).toBe(true);
      expect(path.isAbsolute(item.filePath)).toBe(true);
    });

    it("should resolve filePath using the agent's media_dir override", async () => {
      const customDir = await mkdtemp(
        path.join(os.tmpdir(), "dispatch-media-")
      );
      try {
        const agent = await manager.createAgent({
          cwd: "/tmp",
          useWorktree: false,
        });
        await pool.query(`UPDATE agents SET media_dir = $2 WHERE id = $1`, [
          agent.id,
          customDir,
        ]);

        await pool.query(
          `INSERT INTO media (agent_id, file_name, source, size_bytes)
           VALUES ($1, 'screen.png', 'screenshot', 256)`,
          [agent.id]
        );

        const media = await manager.listMedia(agent.id);
        expect(media).toHaveLength(1);
        expect(media[0]!.filePath).toBe(path.join(customDir, "screen.png"));
        expect(media[0]!.sizeBytes).toBe(256);
      } finally {
        await rm(customDir, { recursive: true, force: true });
      }
    });
  });

  describe("upsertPin", () => {
    it("should add a pin to an agent", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      const updated = await manager.upsertPin(agent.id, {
        label: "URL",
        type: "url",
        value: "https://example.com",
      });

      expect(updated.pins).toHaveLength(1);
      expect(updated.pins![0]).toMatchObject({
        label: "URL",
        type: "url",
        value: "https://example.com",
      });
    });

    it("should overwrite a pin with the same label (case-insensitive)", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await manager.upsertPin(agent.id, {
        label: "URL",
        type: "url",
        value: "https://old.com",
      });

      const updated = await manager.upsertPin(agent.id, {
        label: "url",
        type: "url",
        value: "https://new.com",
      });

      expect(updated.pins).toHaveLength(1);
      expect(updated.pins![0]!.value).toBe("https://new.com");
    });

    it("should keep distinct labels as separate pins", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await manager.upsertPin(agent.id, {
        label: "PR",
        type: "pr",
        value: "#42",
      });

      const updated = await manager.upsertPin(agent.id, {
        label: "URL",
        type: "url",
        value: "https://example.com",
      });

      expect(updated.pins).toHaveLength(2);
    });

    it("should reject when pin cap is reached", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      const pins = Array.from({ length: 50 }, (_, i) => ({
        label: `pin-${i}`,
        type: "string" as const,
        value: `val-${i}`,
      }));
      await pool.query(`UPDATE agents SET pins = $2::jsonb WHERE id = $1`, [
        agent.id,
        JSON.stringify(pins),
      ]);

      await expect(
        manager.upsertPin(agent.id, {
          label: "one-more",
          type: "string",
          value: "overflow",
        })
      ).rejects.toThrow(/Maximum of 50 pins/);
    });

    it("should allow upsert that replaces an existing pin at the cap", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      const pins = Array.from({ length: 50 }, (_, i) => ({
        label: `pin-${i}`,
        type: "string" as const,
        value: `val-${i}`,
      }));
      await pool.query(`UPDATE agents SET pins = $2::jsonb WHERE id = $1`, [
        agent.id,
        JSON.stringify(pins),
      ]);

      const updated = await manager.upsertPin(agent.id, {
        label: "pin-0",
        type: "string",
        value: "updated",
      });

      expect(updated.pins).toHaveLength(50);
      expect(updated.pins!.find((p) => p.label === "pin-0")!.value).toBe(
        "updated"
      );
    });

    it("should throw 404 for non-existent agent", async () => {
      await expect(
        manager.upsertPin("agt_nope", {
          label: "X",
          type: "string",
          value: "y",
        })
      ).rejects.toThrow(/not found/i);
    });
  });

  describe("deletePin", () => {
    it("should remove a pin by label (case-insensitive)", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await manager.upsertPin(agent.id, {
        label: "URL",
        type: "url",
        value: "https://example.com",
      });

      const updated = await manager.deletePin(agent.id, "url");
      expect(updated.pins).toHaveLength(0);
    });

    it("should be a no-op when the label does not exist", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await manager.upsertPin(agent.id, {
        label: "Keep",
        type: "string",
        value: "v",
      });

      const updated = await manager.deletePin(agent.id, "nope");
      expect(updated.pins).toHaveLength(1);
      expect(updated.pins![0]!.label).toBe("Keep");
    });

    it("should throw 404 for non-existent agent", async () => {
      await expect(manager.deletePin("agt_nope", "X")).rejects.toThrow(
        /not found/i
      );
    });
  });

  describe("markSetupFailed", () => {
    it("should mark agent as stopped with the error message", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      const failed = await manager.markSetupFailed(
        agent.id,
        "git worktree add failed"
      );

      expect(failed.status).toBe("stopped");
      expect(failed.lastError).toBe("git worktree add failed");
    });

    it("should trim whitespace from the message", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      const failed = await manager.markSetupFailed(
        agent.id,
        "  spaced message  "
      );

      expect(failed.lastError).toBe("spaced message");
    });

    it("should truncate messages longer than 1000 characters", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      const longMsg = "x".repeat(2000);
      const failed = await manager.markSetupFailed(agent.id, longMsg);

      expect(failed.lastError!.length).toBe(1000);
    });

    it("should default to 'Setup failed.' for empty messages", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      const failed = await manager.markSetupFailed(agent.id, "   ");
      expect(failed.lastError).toBe("Setup failed.");
    });

    it("should set the latest event to blocked", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await manager.markSetupFailed(agent.id, "boom");
      const fetched = await manager.getAgent(agent.id);
      expect(fetched!.latestEvent?.type).toBe("blocked");
      expect(fetched!.latestEvent?.message).toBe("boom");
    });
  });

  describe("updateSetupPhase", () => {
    it("should update the setup phase on a creating agent", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await manager.updateSetupPhase(agent.id, "worktree");

      const fetched = await manager.getAgent(agent.id);
      expect(fetched!.setupPhase).toBe("worktree");
    });

    it("should transition through multiple phases", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await manager.updateSetupPhase(agent.id, "worktree");
      await manager.updateSetupPhase(agent.id, "workspace");

      const fetched = await manager.getAgent(agent.id);
      expect(fetched!.setupPhase).toBe("workspace");
    });
  });

  describe("upsertLatestEventIfCurrent", () => {
    it("should update when expectedUpdatedAt matches", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await manager.upsertLatestEvent(agent.id, {
        type: "working",
        message: "first",
      });

      // The SQL comparison uses `latest_event_updated_at::text`, so we
      // must read the timestamp in the same format the real caller
      // (activity-monitor) uses.
      const { rows } = await pool.query(
        `SELECT latest_event_updated_at::text AS "ts" FROM agents WHERE id = $1`,
        [agent.id]
      );
      const ts = rows[0].ts as string;

      const result = await manager.upsertLatestEventIfCurrent(agent.id, ts, {
        type: "done",
        message: "second",
      });

      expect(result).not.toBeNull();
      expect(result!.latestEvent!.type).toBe("done");
      expect(result!.latestEvent!.message).toBe("second");
    });

    it("should return null when expectedUpdatedAt does not match", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await manager.upsertLatestEvent(agent.id, {
        type: "working",
        message: "first",
      });

      const result = await manager.upsertLatestEventIfCurrent(
        agent.id,
        "1970-01-01 00:00:00",
        { type: "done", message: "stale" }
      );

      expect(result).toBeNull();
    });

    it("should return null for a non-existent agent", async () => {
      const result = await manager.upsertLatestEventIfCurrent(
        "agt_missing",
        "1970-01-01 00:00:00",
        { type: "done", message: "ghost" }
      );

      expect(result).toBeNull();
    });
  });

  describe("checkWorktreeStatus", () => {
    it("should return hasWorktree false for agents without a worktree", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      await manager.completeSetup(agent.id, {
        effectiveCwd: "/tmp",
        worktreePath: null,
        worktreeBranch: null,
      });

      const status = await manager.checkWorktreeStatus(agent.id);
      expect(status.hasWorktree).toBe(false);
      expect(status.worktreePath).toBeNull();
      expect(status.branchName).toBeNull();
      expect(status.changedFiles).toEqual([]);
      expect(status.uncommittedFiles).toEqual([]);
    });

    it("should throw 404 for a non-existent agent", async () => {
      await expect(
        manager.checkWorktreeStatus("agt_does_not_exist")
      ).rejects.toThrow(/not found/i);
    });
  });

  describe("resolveRuntimeCwd", () => {
    it("should return agent cwd for stopped agents without probing runtime", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });
      await manager.completeSetup(agent.id, {
        effectiveCwd: "/tmp/workspace",
        worktreePath: null,
        worktreeBranch: null,
      });
      await manager.stopAgent(agent.id);

      const stopped = (await manager.getAgent(agent.id))!;
      const cwd = await manager.resolveRuntimeCwd(stopped);
      expect(cwd).toBe("/tmp/workspace");
    });

    it("should return agent cwd when tmuxSession is absent", async () => {
      const inertManager = new AgentManager(pool, noopLogger, inertTestConfig);
      const agent = await inertManager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      const fetched = (await inertManager.getAgent(agent.id))!;
      const cwd = await inertManager.resolveRuntimeCwd(fetched);
      expect(cwd).toBe("/tmp");
    });
  });
});
