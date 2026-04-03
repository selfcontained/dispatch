import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { Pool } from "pg";

import { setupTestDb, teardownTestDb, runTestMigrations } from "./setup.js";

// Mock runCommand so AgentManager never touches tmux
vi.mock("@dispatch/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(async (_cmd: string, args: string[]) => {
    // "has-session" check: pretend session exists after creation
    if (args[0] === "has-session") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }),
}));

// We need to dynamically import AgentManager AFTER the mock is in place
const { AgentManager, AgentError } = await import("../../src/agents/manager.js");

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
  agentRuntime: "tmux",
  tls: null,
} satisfies import("../../src/config.js").AppConfig;

const inertTestConfig = {
  ...testConfig,
  agentRuntime: "inert",
} satisfies import("../../src/config.js").AppConfig;

let manager: InstanceType<typeof AgentManager>;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations(pool);
  manager = new AgentManager(pool, noopLogger, testConfig);
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  // Clean up agents between tests
  await pool.query("DELETE FROM agent_feedback");
  await pool.query("DELETE FROM media_seen");
  await pool.query("DELETE FROM media");
  await pool.query("DELETE FROM agents");

  const { runCommand } = await import("@dispatch/shared/lib/run-command.js");
  vi.mocked(runCommand).mockImplementation(async (_cmd: string, args: string[]) => {
    if (args[0] === "has-session") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  });
});

describe("AgentManager", () => {
  describe("createAgent", () => {
    it("should create an agent and return it", async () => {
      const agent = await manager.createAgent({ cwd: "/tmp", useWorktree: false });

      expect(agent.id).toMatch(/^agt_/);
      expect(agent.status).toBe("creating");
      expect(agent.setupPhase).toBe("session");
      expect(agent.cwd).toBe("/tmp");
      expect(agent.type).toBe("codex");
      expect(agent.tmuxSession).toMatch(/^dispatch_agt_/);
      expect(agent.mediaDir).toBeTruthy();
      expect(agent.createdAt).toBeTruthy();
    });

    it("should use a custom name when provided", async () => {
      const agent = await manager.createAgent({ name: "my-agent", cwd: "/tmp", useWorktree: false });
      expect(agent.name).toBe("my-agent");
    });

    it("should generate a default name from ID suffix", async () => {
      const agent = await manager.createAgent({ cwd: "/tmp", useWorktree: false });
      expect(agent.name).toMatch(/^agent-/);
    });

    it("should support claude agent type", async () => {
      const agent = await manager.createAgent({ type: "claude", cwd: "/tmp", useWorktree: false });
      expect(agent.type).toBe("claude");
    });

    it("should support opencode agent type", async () => {
      const agent = await manager.createAgent({ type: "opencode", cwd: "/tmp", useWorktree: false });
      expect(agent.type).toBe("opencode");
    });

    it("should store agentArgs", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        agentArgs: ["--model", "o3"],
        useWorktree: false,
      });
      expect(agent.agentArgs).toEqual(["--model", "o3"]);
    });

    it("should persist fullAccess", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        fullAccess: true,
        useWorktree: false,
      });
      expect(agent.fullAccess).toBe(true);
    });

    it("should reject non-absolute paths", async () => {
      await expect(manager.createAgent({ cwd: "relative/path" })).rejects.toThrow(
        "absolute path"
      );
    });

    it("should reject non-existent directories", async () => {
      await expect(
        manager.createAgent({ cwd: "/nonexistent-dispatch-test-dir" })
      ).rejects.toThrow("does not exist");
    });

    it("should create inert agents without invoking tmux", async () => {
      const { runCommand } = await import("@dispatch/shared/lib/run-command.js");
      const inertManager = new AgentManager(pool, noopLogger, inertTestConfig);
      vi.mocked(runCommand).mockClear();

      const agent = await inertManager.createAgent({ cwd: "/tmp", useWorktree: false });

      expect(agent.status).toBe("running");
      expect(vi.mocked(runCommand)).not.toHaveBeenCalled();
    });

    it("should inject an agent-scoped MCP URL into Codex launches", async () => {
      const agent = await manager.createAgent({ cwd: "/tmp", type: "codex", useWorktree: false });

      // The setup script should contain the MCP configuration
      const setupScript = await readFile(`/tmp/dispatch_setup_${agent.id}.sh`, "utf-8");
      expect(setupScript).toContain("mcp_servers.dispatch.url=");
      expect(setupScript).toContain(`/api/mcp/${agent.id}`);
      expect(setupScript).toContain("mcp_servers.dispatch.bearer_token_env_var=");
      expect(setupScript).toContain("DISPATCH_AUTH_TOKEN=");
    });

    it("should inject an agent-scoped MCP URL into Claude launches", async () => {
      const agent = await manager.createAgent({ cwd: "/tmp", type: "claude", useWorktree: false });

      // The setup script should contain the MCP configuration
      const setupScript = await readFile(`/tmp/dispatch_setup_${agent.id}.sh`, "utf-8");
      expect(setupScript).toContain("--mcp-config");
      expect(setupScript).toContain(`/api/mcp/${agent.id}`);
    });

    it("should generate a setup script with worktree steps when useWorktree is true", async () => {
      const agent = await manager.createAgent({ cwd: "/tmp", type: "claude", useWorktree: true });

      expect(agent.setupPhase).toBe("worktree");
      const setupScript = await readFile(`/tmp/dispatch_setup_${agent.id}.sh`, "utf-8");
      expect(setupScript).toContain("Creating git worktree");
      expect(setupScript).toContain("Copying environment files");
      expect(setupScript).toContain("Installing dependencies");
      expect(setupScript).toContain("Starting agent session");
      expect(setupScript).toContain("setup/complete");
      expect(setupScript).toContain("exec bash");
    });

    it("should skip worktree steps in setup script when useWorktree is false", async () => {
      const agent = await manager.createAgent({ cwd: "/tmp", type: "claude", useWorktree: false });

      expect(agent.setupPhase).toBe("session");
      const setupScript = await readFile(`/tmp/dispatch_setup_${agent.id}.sh`, "utf-8");
      expect(setupScript).not.toContain("Creating git worktree");
      expect(setupScript).toContain("Starting agent session");
      expect(setupScript).toContain("exec bash");
    });

    it("should complete setup and transition to running", async () => {
      const agent = await manager.createAgent({ cwd: "/tmp", useWorktree: false });
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
      await manager.createAgent({ name: "first", cwd: "/tmp", useWorktree: false });
      await manager.createAgent({ name: "second", cwd: "/tmp", useWorktree: false });

      const agents = await manager.listAgents();
      expect(agents.length).toBe(2);
      expect(agents[0].name).toBe("second");
      expect(agents[1].name).toBe("first");
    });

    it("should fetch a single agent by ID", async () => {
      const created = await manager.createAgent({ name: "fetch-me", cwd: "/tmp", useWorktree: false });
      const fetched = await manager.getAgent(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.name).toBe("fetch-me");
    });
  });

  describe("getTerminalAccess", () => {
    it("should return inert terminal metadata for inert runtime agents", async () => {
      const inertManager = new AgentManager(pool, noopLogger, inertTestConfig);
      const agent = await inertManager.createAgent({ cwd: "/tmp" });

      const access = await inertManager.getTerminalAccess(agent.id);

      expect(access.mode).toBe("inert");
      expect(access.message).toContain("inert mode");
    });
  });

  describe("upsertLatestEvent", () => {
    it("should persist an event on an agent", async () => {
      const agent = await manager.createAgent({ cwd: "/tmp", useWorktree: false });

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
      const agent = await manager.createAgent({ cwd: "/tmp", useWorktree: false });

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
      const agent = await manager.createAgent({ cwd: "/tmp", useWorktree: false });

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
      const agent = await manager.createAgent({ cwd: "/tmp", useWorktree: false });

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
    async function archiveAgent(id: string, cleanupWorktree: "auto" | "keep" | "force" = "auto"): Promise<void> {
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
      const agent = await manager.createAgent({ cwd: "/tmp", useWorktree: false });

      // Stop first so beginArchive doesn't need force
      await manager.stopAgent(agent.id, { force: true });
      await archiveAgent(agent.id);

      // getAgent filters out soft-deleted agents
      const fetched = await manager.getAgent(agent.id);
      expect(fetched).toBeNull();

      // But the row still exists in the database with deleted_at set
      const row = await pool.query("SELECT deleted_at FROM agents WHERE id = $1", [agent.id]);
      expect(row.rowCount).toBe(1);
      expect(row.rows[0].deleted_at).not.toBeNull();
    });

    it("should exclude soft-deleted agents from listAgents", async () => {
      const agent = await manager.createAgent({ cwd: "/tmp", useWorktree: false });
      await manager.stopAgent(agent.id, { force: true });
      await archiveAgent(agent.id);

      const agents = await manager.listAgents();
      expect(agents.find((a) => a.id === agent.id)).toBeUndefined();
    });

    it("should preserve media rows after soft delete", async () => {
      const agent = await manager.createAgent({ cwd: "/tmp", useWorktree: false });

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
      const media = await pool.query("SELECT * FROM media WHERE agent_id = $1", [agent.id]);
      const seen = await pool.query("SELECT * FROM media_seen WHERE agent_id = $1", [agent.id]);
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
      const agent = await manager.createAgent({ cwd: "/tmp", useWorktree: false });
      await manager.stopAgent(agent.id, { force: true });

      const archiving = await manager.beginArchive(agent.id);
      expect(archiving.status).toBe("archiving");
      expect(archiving.archivePhase).toBe("stopping");
    });

    it("should reject archiving an already-archiving agent", async () => {
      const agent = await manager.createAgent({ cwd: "/tmp", useWorktree: false });
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
      const agent = await manager.createAgent({ cwd: "/tmp", useWorktree: false });
      expect(agent.status).toBe("creating");

      const stopped = await manager.stopAgent(agent.id, { force: true });
      expect(stopped.status).toBe("stopped");
    });

    it("should be a no-op for already stopped agent", async () => {
      const agent = await manager.createAgent({ cwd: "/tmp", useWorktree: false });
      await manager.stopAgent(agent.id, { force: true });

      const result = await manager.stopAgent(agent.id);
      expect(result.status).toBe("stopped");
    });

    it("should stop inert agents without invoking tmux", async () => {
      const { runCommand } = await import("@dispatch/shared/lib/run-command.js");
      const inertManager = new AgentManager(pool, noopLogger, inertTestConfig);
      const agent = await inertManager.createAgent({ cwd: "/tmp" });
      vi.mocked(runCommand).mockClear();

      const stopped = await inertManager.stopAgent(agent.id, { force: true });

      expect(stopped.status).toBe("stopped");
      expect(vi.mocked(runCommand)).not.toHaveBeenCalled();
    });
  });

  describe("reconcileAgents", () => {
    it("should mark agents as stopped when tmux session is gone", async () => {
      const agent = await manager.createAgent({ cwd: "/tmp", useWorktree: false });

      // Now make tmux report no session
      const { runCommand } = await import("@dispatch/shared/lib/run-command.js");
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

    it("should capture a missing-session diagnostic snapshot", async () => {
      const tempHome = await mkdtemp(path.join(os.tmpdir(), "dispatch-agent-manager-home-"));
      const previousHome = process.env.HOME;
      process.env.HOME = tempHome;

      try {
        const agent = await manager.createAgent({ cwd: "/tmp", useWorktree: false });

        const { runCommand } = await import("@dispatch/shared/lib/run-command.js");
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
            return { exitCode: 0, stdout: "  PID  PPID  PGID USER COMMAND\n", stderr: "" };
          }
          if (_cmd === "launchctl") {
            return { exitCode: 0, stdout: "launchctl snapshot", stderr: "" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        });

        await manager.reconcileAgentStatuses();

        const diagnosticsDir = path.join(tempHome, ".dispatch", "diagnostics");
        const files = await readdir(diagnosticsDir);
        const incidentFile = files.find((file) => file.includes(`missing-session-${agent.id}.json`));
        expect(incidentFile).toBeTruthy();

        const incidentRaw = await readFile(path.join(diagnosticsDir, incidentFile!), "utf-8");
        const incident = JSON.parse(incidentRaw) as {
          incident: string;
          agent: { agentId: string; tmuxSession: string; exitInfo: number | null };
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
      const parentA = await manager.createAgent({ name: "parent-a", cwd: "/tmp", useWorktree: false });
      const parentB = await manager.createAgent({ name: "parent-b", cwd: "/tmp", useWorktree: false });

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
      expect(resultA.personas[0].feedback[0].description).toBe("SQL injection in login handler");

      // Parent B should only see child B's feedback
      const resultB = await manager.listFeedbackByParentGrouped(parentB.id);
      expect(resultB.personas).toHaveLength(1);
      expect(resultB.personas[0].persona).toBe("ux-review");
      expect(resultB.personas[0].agentId).toBe(childB.id);
      expect(resultB.personas[0].feedback).toHaveLength(1);
      expect(resultB.personas[0].feedback[0].description).toBe("Button color contrast");
    });

    it("should return empty personas array when agent has no children", async () => {
      const parent = await manager.createAgent({ name: "lonely-parent", cwd: "/tmp", useWorktree: false });

      const result = await manager.listFeedbackByParentGrouped(parent.id);
      expect(result.personas).toHaveLength(0);
    });

    it("should filter by persona name", async () => {
      const parent = await manager.createAgent({ name: "multi-parent", cwd: "/tmp", useWorktree: false });

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

      const filtered = await manager.listFeedbackByParentGrouped(parent.id, "security-review");
      expect(filtered.personas).toHaveLength(1);
      expect(filtered.personas[0].persona).toBe("security-review");
      expect(filtered.personas[0].feedback[0].description).toBe("sec finding");
    });

    it("should group multiple feedback items under the same persona", async () => {
      const parent = await manager.createAgent({ name: "parent", cwd: "/tmp", useWorktree: false });
      const child = await manager.createAgent({
        name: "child",
        cwd: "/tmp",
        useWorktree: false,
        persona: "security-review",
        parentAgentId: parent.id,
      });

      await manager.submitFeedback(child.id, { severity: "critical", description: "finding 1" });
      await manager.submitFeedback(child.id, { severity: "low", description: "finding 2" });

      const result = await manager.listFeedbackByParentGrouped(parent.id);
      expect(result.personas).toHaveLength(1);
      expect(result.personas[0].feedback).toHaveLength(2);
      expect(result.personas[0].feedback[0].description).toBe("finding 1");
      expect(result.personas[0].feedback[1].description).toBe("finding 2");
    });
  });

  describe("updateFeedbackStatusByParent", () => {
    it("should allow a parent to resolve its child's feedback", async () => {
      const parent = await manager.createAgent({ name: "parent", cwd: "/tmp", useWorktree: false });
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

      const updated = await manager.updateFeedbackStatusByParent(feedback.id, parent.id, "fixed");
      expect(updated).not.toBeNull();
      expect(updated!.id).toBe(feedback.id);
      expect(updated!.status).toBe("fixed");
    });

    it("should return null when parent does not own the child", async () => {
      const parentA = await manager.createAgent({ name: "parent-a", cwd: "/tmp", useWorktree: false });
      const parentB = await manager.createAgent({ name: "parent-b", cwd: "/tmp", useWorktree: false });
      const child = await manager.createAgent({
        name: "child",
        cwd: "/tmp",
        useWorktree: false,
        persona: "security-review",
        parentAgentId: parentA.id,
      });

      const feedback = await manager.submitFeedback(child.id, { description: "finding" });

      const result = await manager.updateFeedbackStatusByParent(feedback.id, parentB.id, "ignored");
      expect(result).toBeNull();
    });

    it("should return null for non-existent feedback id", async () => {
      const parent = await manager.createAgent({ name: "parent", cwd: "/tmp", useWorktree: false });

      const result = await manager.updateFeedbackStatusByParent(99999, parent.id, "fixed");
      expect(result).toBeNull();
    });
  });
});
