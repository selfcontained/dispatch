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
const {
  AgentManager,
  AgentError,
  LAUNCH_CONTEXT_RESOLVE_TIMEOUT_MS,
  LAUNCH_CONTEXT_WRITE_TIMEOUT_MS,
} = await import("../../src/agents/manager.js");
const { ChatService } = await import("../../src/chat/service.js");
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

let chatEvents: unknown[] = [];

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  manager = new AgentManager(pool, noopLogger, testConfig);
  // The Chat feed's launch-context recorder, wired the way server.ts does.
  manager.attachLaunchContextRecorder(
    new ChatService({
      pool,
      publishUiEvent: (event) => chatEvents.push(event),
      getAgent: (id) => manager.getAgent(id),
      mediaRoot: testConfig.mediaRoot,
    })
  );
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  // Clean up agents between tests
  chatEvents = [];
  await pool.query("DELETE FROM agent_chat_messages");
  await pool.query("DELETE FROM agent_token_usage");
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

    describe("launch context in the Chat feed", () => {
      async function launchPosts(agentId: string) {
        const result = await pool.query(
          `SELECT * FROM agent_chat_messages WHERE agent_id = $1 ORDER BY created_at`,
          [agentId]
        );
        return result.rows as Array<{
          id: string;
          author_kind: string;
          kind: string;
          text: string;
          delivered: boolean | null;
          origin: string | null;
          launched_by_agent_id: string | null;
          attachments: Array<Record<string, unknown>>;
        }>;
      }

      it("records the prompt, startup file, link and pins as one delivered user post", async () => {
        const agent = await manager.createAgent({
          cwd: "/tmp",
          useWorktree: false,
          initialPrompt: "Build the widget",
          launchContext: { links: ["https://example.com/spec"] },
          initialPins: [
            {
              label: "example.com",
              value: "https://example.com/spec",
              type: "url",
            },
            { label: "Ticket", value: "DIS-42", type: "string" },
          ],
          initialFiles: [
            {
              fileName: "brief.md",
              originalName: "brief.md",
              buffer: Buffer.from("# brief"),
              source: "text",
            },
          ],
        });
        const posts = await launchPosts(agent.id);
        expect(posts).toHaveLength(1);
        const media = await pool.query<{ id: number; file_name: string }>(
          `SELECT id, file_name FROM media WHERE agent_id = $1`,
          [agent.id]
        );
        const ticketPin = agent.pins.find((pin) => pin.label === "Ticket");
        expect(posts[0]).toMatchObject({
          author_kind: "user",
          kind: "reply",
          text: "Build the widget",
          delivered: true,
          origin: "launch",
          launched_by_agent_id: null,
          attachments: [
            {
              type: "file",
              mediaId: media.rows[0].id,
              fileName: media.rows[0].file_name,
              sizeBytes: 7,
            },
            { type: "link", url: "https://example.com/spec" },
            // The url pin made from the link is not repeated; the other is.
            { type: "pin", pinId: ticketPin?.id },
          ],
        });
        expect(chatEvents).toEqual([
          { type: "chat.changed", agentId: agent.id },
        ]);
      });

      it("records nothing for a bare launch or a terminal agent", async () => {
        const bare = await manager.createAgent({
          cwd: "/tmp",
          useWorktree: false,
        });
        expect(await launchPosts(bare.id)).toEqual([]);
        const terminal = await manager.createAgent({
          cwd: "/tmp",
          type: "terminal",
          useWorktree: false,
          initialPrompt: "ignored",
        });
        expect(await launchPosts(terminal.id)).toEqual([]);
        expect(chatEvents).toEqual([]);
      });

      it("attributes an agent-launched post to the launcher and uses the unwrapped prompt", async () => {
        const parent = await manager.createAgent({
          cwd: "/tmp",
          useWorktree: false,
        });
        const child = await manager.createAgent({
          cwd: "/tmp",
          useWorktree: false,
          parentAgentId: parent.id,
          launchedByAgentId: parent.id,
          initialPrompt: `You were launched by "${parent.id}".\n\nReview the diff`,
          launchContext: { prompt: "Review the diff" },
        });
        const posts = await launchPosts(child.id);
        expect(posts).toHaveLength(1);
        expect(posts[0]).toMatchObject({
          author_kind: "user",
          text: "Review the diff",
          origin: "launch",
          launched_by_agent_id: parent.id,
          delivered: true,
        });

        // child: false launches carry the launcher but no parent.
        const independent = await manager.createAgent({
          cwd: "/tmp",
          useWorktree: false,
          launchedByAgentId: parent.id,
          initialPrompt: "Go",
        });
        expect((await launchPosts(independent.id))[0]).toMatchObject({
          launched_by_agent_id: parent.id,
          text: "Go",
        });
      });

      it("never attributes the post from parentAgentId alone", async () => {
        // The create route accepts parentAgentId from the request body, so
        // only the explicit launcher (set by agent-authenticated launch
        // paths) may name who the post reads as.
        const parent = await manager.createAgent({
          cwd: "/tmp",
          useWorktree: false,
        });
        const child = await manager.createAgent({
          cwd: "/tmp",
          useWorktree: false,
          parentAgentId: parent.id,
          initialPrompt: "Pretend I am the parent",
        });
        expect((await launchPosts(child.id))[0]).toMatchObject({
          author_kind: "user",
          text: "Pretend I am the parent",
          launched_by_agent_id: null,
        });
      });

      it("hands the CLI the same post id and attachment lines when the chat surface is on", async () => {
        await pool.query(
          `INSERT INTO settings (key, value, updated_at)
           VALUES ('chat_surface_enabled', 'true', NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
        );
        try {
          const agent = await manager.createAgent({
            cwd: "/tmp",
            type: "claude",
            useWorktree: false,
            initialPrompt: "Build the widget",
            launchContext: { links: ["https://example.com/spec"] },
            initialFiles: [
              {
                fileName: "brief.md",
                originalName: "brief.md",
                buffer: Buffer.from("# brief"),
                source: "text",
              },
            ],
          });
          const posts = await launchPosts(agent.id);
          expect(posts).toHaveLength(1);
          const setupScript = await readFile(
            `/tmp/dispatch_setup_${agent.id}.sh`,
            "utf-8"
          );
          // The envelope the CLI receives names the post that was written,
          // so the agent's reply threads onto the launch post in the feed.
          expect(setupScript).toContain(
            `--- DISPATCH CHAT (id: ${posts[0].id}) ---`
          );
          expect(setupScript).toContain(`replyTo: "${posts[0].id}"`);
          expect(setupScript).toContain("Build the widget");
          // Attachment lines come from the recorder, so pane and post agree.
          const media = await pool.query<{ file_name: string }>(
            `SELECT file_name FROM media WHERE agent_id = $1`,
            [agent.id]
          );
          expect(setupScript).toContain(
            `- file: ${path.join(testConfig.mediaRoot, agent.id, media.rows[0].file_name)} (text/markdown, 7 B)`
          );
          expect(setupScript).toContain("- link: https://example.com/spec");
        } finally {
          await pool.query(
            `DELETE FROM settings WHERE key = 'chat_surface_enabled'`
          );
        }
      });

      it("leaves the first turn unwrapped when the chat surface is off", async () => {
        const agent = await manager.createAgent({
          cwd: "/tmp",
          type: "claude",
          useWorktree: false,
          initialPrompt: "Build the widget",
        });
        expect(await launchPosts(agent.id)).toHaveLength(1);
        const setupScript = await readFile(
          `/tmp/dispatch_setup_${agent.id}.sh`,
          "utf-8"
        );
        expect(setupScript).not.toContain("DISPATCH CHAT");
        expect(setupScript).toContain("Build the widget");
      });

      it("starts the runtime without waiting on a write that never resolves", async () => {
        const warn = vi.fn();
        const stuckManager = new AgentManager(
          pool,
          { ...noopLogger, warn, child: () => noopLogger } as never,
          inertTestConfig
        );
        // The recorder is handed the new agent's id; capture it so the poll
        // below addresses that row directly instead of guessing by clock
        // (DB now() vs Date.now() skew made the old created_at filter flaky).
        let recordedAgentId: string | null = null;
        stuckManager.attachLaunchContextRecorder({
          prepareLaunchContext: async (input) => {
            recordedAgentId = input.agentId;
            return {
              attachmentLines: [],
              record: () => new Promise(() => {}),
            };
          },
        });

        const startedAt = Date.now();
        const pending = stuckManager.createAgent({
          cwd: "/tmp",
          useWorktree: false,
          initialPrompt: "Go",
        });
        // The runtime launch runs alongside the stuck write: the agent row
        // reaches "running" long before the write's bounded wait expires.
        const running = await vi.waitFor(
          async () => {
            expect(recordedAgentId).not.toBeNull();
            const result = await pool.query<{ status: string }>(
              `SELECT status FROM agents WHERE id = $1 AND status = 'running'`,
              [recordedAgentId]
            );
            expect(result.rows).toHaveLength(1);
            return result.rows[0];
          },
          { timeout: 4000, interval: 50 }
        );
        expect(running.status).toBe("running");
        expect(Date.now() - startedAt).toBeLessThan(
          LAUNCH_CONTEXT_WRITE_TIMEOUT_MS
        );

        // createAgent itself returns once the bounded wait expires, and says so.
        const agent = await pending;
        expect(agent.status).toBe("running");
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: agent.id,
            timeoutMs: LAUNCH_CONTEXT_WRITE_TIMEOUT_MS,
          }),
          expect.stringContaining("launch context write still pending")
        );
        expect(await launchPosts(agent.id)).toEqual([]);
      }, 15_000);

      it("launches unwrapped when the post never resolves", async () => {
        // Resolving the post is on the critical path (the first turn needs
        // its id), so a hung read gives up: no post, no envelope, and the
        // launch still happens.
        const warn = vi.fn();
        const stuckManager = new AgentManager(
          pool,
          { ...noopLogger, warn, child: () => noopLogger } as never,
          testConfig
        );
        stuckManager.attachLaunchContextRecorder({
          prepareLaunchContext: () => new Promise(() => {}),
        });

        const agent = await stuckManager.createAgent({
          cwd: "/tmp",
          type: "claude",
          useWorktree: false,
          initialPrompt: "Go",
        });
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: agent.id,
            timeoutMs: LAUNCH_CONTEXT_RESOLVE_TIMEOUT_MS,
          }),
          expect.stringContaining("did not resolve in time")
        );
        expect(await launchPosts(agent.id)).toEqual([]);
        const setupScript = await readFile(
          `/tmp/dispatch_setup_${agent.id}.sh`,
          "utf-8"
        );
        expect(setupScript).not.toContain("DISPATCH CHAT");
        expect(setupScript).toContain("Go");
      }, 15_000);
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
      expect(setupScript).not.toContain("dispatch-<tool_name>");
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
      expect(setupScript).toContain("dispatch-<tool_name>");
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
      // The proactive gates: nothing can inject these at the right moment,
      // because the moment is the agent deciding it's done.
      expect(setupScript).toContain("Autonomous Review is enabled");
      expect(setupScript).toContain("list_personas");
      expect(setupScript).toContain("dispatch_launch_persona");
      // No apostrophes: the guidance is shell-escaped into this script.
      expect(setupScript).toContain("until all submitted reviews are resolved");
      // Injection is best-effort and dropped when the agent has no session,
      // so the recovery pointer stays durable.
      expect(setupScript).toContain("dispatch_review_list_feedback");
      // The rest of the reactive half is delivered by injection when it
      // applies (buildLaunchPersonaResponseText /
      // reviews/injection-prompts.ts), so it no longer rides along.
      expect(setupScript).not.toContain("structured REVIEW SUBMITTED prompt");
      expect(setupScript).not.toContain("ask the reviewer to verify it");
      expect(setupScript).not.toContain("zero-item approval");
      expect(setupScript).not.toContain(
        "set each outcome with dispatch_review_resolve"
      );
      expect(setupScript).not.toContain("dispatch_get_feedback");
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
      expect(setupScript).not.toContain("dispatch-<tool_name>");
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
      expect(setupScript).toContain("dispatch-<tool_name>");
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

    it("should expose the submitted review ID for a review agent", async () => {
      const parent = await manager.createAgent({
        name: "parent",
        cwd: "/tmp",
        useWorktree: false,
      });
      const reviewer = await manager.createAgent({
        name: "reviewer",
        cwd: "/tmp",
        useWorktree: false,
        role: "review",
        parentAgentId: parent.id,
      });
      const inserted = await pool.query<{ id: number }>(
        `INSERT INTO reviews
           (agent_id, assigned_agent_id, reviewer_type, reviewer_agent_id, summary, status)
         VALUES ($1, $1, 'agent', $2, 'Looks good.', 'resolved')
         RETURNING id`,
        [parent.id, reviewer.id]
      );

      const fetched = await manager.getAgent(reviewer.id);
      expect(fetched?.submittedReviewId).toBe(inserted.rows[0]?.id);
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

    it("should resolve a legacy home-relative media_dir before restarting", async () => {
      const { runCommand } =
        await import("../../src/shared/lib/run-command.js");
      const agent = await createStoppedAgent({ type: "claude" });
      const fakeHome = await mkdtemp(path.join(os.tmpdir(), "dispatch-home-"));
      const legacyMediaDir = `~/.dispatch/legacy-media-${agent.id}`;
      const expectedMediaDir = path.join(
        fakeHome,
        ".dispatch",
        `legacy-media-${agent.id}`
      );
      const newSessionArgs: string[][] = [];
      const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

      try {
        await pool.query(`UPDATE agents SET media_dir = $2 WHERE id = $1`, [
          agent.id,
          legacyMediaDir,
        ]);
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

        expect(newSessionArgs).toHaveLength(1);
        expect(newSessionArgs[0]!.join(" ")).toContain(expectedMediaDir);
      } finally {
        homedirSpy.mockRestore();
        await rm(fakeHome, { recursive: true, force: true });
      }
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

    it("should skip harvesting only when the runtime is inert", async () => {
      const { cwdToClaudeProjectDir } =
        await import("../../src/agents/token-harvester.js");
      const projectDir = cwdToClaudeProjectDir(tmpDir);
      await mkdir(projectDir, { recursive: true });

      const inertManager = new AgentManager(pool, noopLogger, inertTestConfig);
      const agent = await inertManager.createAgent({
        name: "inert-agent",
        type: "claude",
        cwd: tmpDir,
        useWorktree: false,
      });
      await writeFile(
        path.join(projectDir, `${agent.cliSessionId}.jsonl`),
        `${JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-opus-4-6",
            usage: { input_tokens: 500, output_tokens: 10 },
          },
          timestamp: "2026-04-01T10:00:00.000Z",
        })}\n`
      );

      await inertManager.harvestAgentTokens(agent);

      const usage = await pool.query(
        `SELECT COUNT(*)::int AS count FROM agent_token_usage WHERE agent_id = $1`,
        [agent.id]
      );
      expect(usage.rows[0].count).toBe(0);

      await manager.harvestAgentTokens(agent);

      const trackedRuntimeUsage = await pool.query(
        `SELECT SUM(input_tokens)::int AS total FROM agent_token_usage WHERE agent_id = $1`,
        [agent.id]
      );
      expect(trackedRuntimeUsage.rows[0].total).toBe(500);

      await rm(projectDir, { recursive: true, force: true });
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
      // Point the codex harvest at an empty temp dir: without this the
      // harvester walks the real ~/.codex/sessions, and on a developer
      // machine (or the self-hosted runner) that can be gigabytes of
      // rollout files — enough to blow the test timeout.
      const codexHome = await mkdtemp(
        path.join(os.tmpdir(), "dispatch-codex-home-")
      );
      const previousCodexHome = process.env.CODEX_HOME;
      process.env.CODEX_HOME = codexHome;
      try {
        const agent = await manager.createAgent({
          name: "codex-agent",
          type: "codex",
          cwd: "/tmp",
          useWorktree: false,
        });

        // Should not throw — codex agents don't use session ownership
        await manager.harvestAgentTokens(agent);

        // No sessions exist under the isolated CODEX_HOME, so nothing is
        // harvested.
        const usage = await pool.query(
          `SELECT COUNT(*)::int AS count FROM agent_token_usage WHERE agent_id = $1`,
          [agent.id]
        );
        expect(usage.rows[0].count).toBe(0);
      } finally {
        if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousCodexHome;
        await rm(codexHome, { recursive: true, force: true });
      }
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

      await writeFile(item.filePath, "shared media");
      await expect(readFile(item.filePath, "utf-8")).resolves.toBe(
        "shared media"
      );
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

      const { agent: updated } = await manager.upsertPin(agent.id, {
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

      const { agent: updated } = await manager.upsertPin(agent.id, {
        label: "url",
        type: "url",
        value: "https://new.com",
      });

      expect(updated.pins).toHaveLength(1);
      expect(updated.pins![0]!.value).toBe("https://new.com");
    });

    it("merges into an existing pin instead of replacing it", async () => {
      // Regression: adding a group to an existing shortcut wiped its icon,
      // caption, and variant, because the agent had to restate every field.
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      const first = await manager.upsertPin(agent.id, {
        label: "What day is it?",
        type: "shortcut",
        value: "What day is it today?",
        caption: "Day-related",
        icon: "clock",
        variant: "primary",
      });
      expect(first.created).toBe(true);

      const second = await manager.upsertPin(agent.id, {
        label: "What day is it?",
        type: "shortcut",
        value: "What day is it today?",
        group: "Day quick actions",
      });

      expect(second.created).toBe(false);
      expect(second.agent.pins).toHaveLength(1);
      expect(second.agent.pins![0]).toMatchObject({
        id: first.pin.id,
        group: "Day quick actions",
        caption: "Day-related",
        icon: "clock",
        variant: "primary",
      });
    });

    it("clears a decoration when it is sent as an empty string", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await manager.upsertPin(agent.id, {
        label: "Status",
        type: "string",
        value: "green",
        caption: "from CI",
      });
      const cleared = await manager.upsertPin(agent.id, {
        label: "Status",
        type: "string",
        value: "green",
        caption: "",
      });

      expect(cleared.agent.pins![0]).not.toHaveProperty("caption");
    });

    it("keeps a pin in place when it is updated", async () => {
      // Position stability matters for grouping: a re-pinned member must not
      // jump to the end of the list.
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await manager.upsertPin(agent.id, {
        label: "First",
        type: "string",
        value: "a",
      });
      await manager.upsertPin(agent.id, {
        label: "Second",
        type: "string",
        value: "b",
      });
      const { agent: updated } = await manager.upsertPin(agent.id, {
        label: "First",
        type: "string",
        value: "changed",
      });

      expect(updated.pins!.map((p) => p.label)).toEqual(["First", "Second"]);
      expect(updated.pins![0]!.value).toBe("changed");
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

      const { agent: updated } = await manager.upsertPin(agent.id, {
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

      const { agent: updated } = await manager.upsertPin(agent.id, {
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

  describe("deletePinById", () => {
    it("should remove a pin by stable ID", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await manager.upsertPin(agent.id, {
        label: "URL",
        type: "url",
        value: "https://example.com",
      });

      const pinId = (await manager.getAgent(agent.id))!.pins[0]!.id!;
      const updated = await manager.deletePinById(agent.id, pinId);
      expect(updated.pins).toHaveLength(0);
    });

    it("should throw when the pin ID does not exist", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        useWorktree: false,
      });

      await manager.upsertPin(agent.id, {
        label: "Keep",
        type: "string",
        value: "v",
      });

      await expect(manager.deletePinById(agent.id, "nope")).rejects.toThrow(
        /pin not found/i
      );
    });

    it("should throw 404 for non-existent agent", async () => {
      await expect(manager.deletePinById("agt_nope", "X")).rejects.toThrow(
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
