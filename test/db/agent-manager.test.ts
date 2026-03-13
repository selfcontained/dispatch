import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { Pool } from "pg";

import { setupTestDb, teardownTestDb, runTestMigrations } from "./setup.js";

// Mock runCommand so AgentManager never touches tmux
vi.mock("../../src/lib/run-command.js", () => ({
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
  tls: null,
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
  await pool.query("DELETE FROM media_seen");
  await pool.query("DELETE FROM media");
  await pool.query("DELETE FROM agents");

  const { runCommand } = await import("../../src/lib/run-command.js");
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
      const agent = await manager.createAgent({ cwd: "/tmp" });

      expect(agent.id).toMatch(/^agt_/);
      expect(agent.status).toBe("running");
      expect(agent.cwd).toBe("/tmp");
      expect(agent.type).toBe("codex");
      expect(agent.tmuxSession).toMatch(/^dispatch_agt_/);
      expect(agent.mediaDir).toBeTruthy();
      expect(agent.createdAt).toBeTruthy();
    });

    it("should use a custom name when provided", async () => {
      const agent = await manager.createAgent({ name: "my-agent", cwd: "/tmp" });
      expect(agent.name).toBe("my-agent");
    });

    it("should generate a default name from ID suffix", async () => {
      const agent = await manager.createAgent({ cwd: "/tmp" });
      expect(agent.name).toMatch(/^agent-/);
    });

    it("should support claude agent type", async () => {
      const agent = await manager.createAgent({ type: "claude", cwd: "/tmp" });
      expect(agent.type).toBe("claude");
    });

    it("should support opencode agent type", async () => {
      const agent = await manager.createAgent({ type: "opencode", cwd: "/tmp" });
      expect(agent.type).toBe("opencode");
    });

    it("should store agentArgs", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        agentArgs: ["--model", "o3"],
      });
      expect(agent.agentArgs).toEqual(["--model", "o3"]);
    });

    it("should persist fullAccess", async () => {
      const agent = await manager.createAgent({
        cwd: "/tmp",
        fullAccess: true,
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
  });

  describe("getAgent / listAgents", () => {
    it("should return null for non-existent agent", async () => {
      const agent = await manager.getAgent("agt_does_not_exist");
      expect(agent).toBeNull();
    });

    it("should list created agents in descending order", async () => {
      await manager.createAgent({ name: "first", cwd: "/tmp" });
      await manager.createAgent({ name: "second", cwd: "/tmp" });

      const agents = await manager.listAgents();
      expect(agents.length).toBe(2);
      expect(agents[0].name).toBe("second");
      expect(agents[1].name).toBe("first");
    });

    it("should fetch a single agent by ID", async () => {
      const created = await manager.createAgent({ name: "fetch-me", cwd: "/tmp" });
      const fetched = await manager.getAgent(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.name).toBe("fetch-me");
    });
  });

  describe("upsertLatestEvent", () => {
    it("should persist an event on an agent", async () => {
      const agent = await manager.createAgent({ cwd: "/tmp" });

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
      const agent = await manager.createAgent({ cwd: "/tmp" });

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
      const agent = await manager.createAgent({ cwd: "/tmp" });

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
      const agent = await manager.createAgent({ cwd: "/tmp" });

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

  describe("deleteAgent", () => {
    it("should delete an agent", async () => {
      const agent = await manager.createAgent({ cwd: "/tmp" });

      // Stop first so delete doesn't need force
      await manager.stopAgent(agent.id, { force: true });
      await manager.deleteAgent(agent.id);

      const fetched = await manager.getAgent(agent.id);
      expect(fetched).toBeNull();
    });

    it("should cascade-delete media and media_seen", async () => {
      const agent = await manager.createAgent({ cwd: "/tmp" });

      // Insert media directly
      await pool.query(
        `INSERT INTO media (agent_id, file_name, source, size_bytes) VALUES ($1, 'test.png', 'screenshot', 100)`,
        [agent.id]
      );
      await pool.query(
        `INSERT INTO media_seen (agent_id, media_key) VALUES ($1, 'test.png')`,
        [agent.id]
      );

      await manager.deleteAgent(agent.id, true);

      const media = await pool.query("SELECT * FROM media WHERE agent_id = $1", [agent.id]);
      const seen = await pool.query("SELECT * FROM media_seen WHERE agent_id = $1", [agent.id]);
      expect(media.rowCount).toBe(0);
      expect(seen.rowCount).toBe(0);
    });

    it("should throw 404 for non-existent agent", async () => {
      try {
        await manager.deleteAgent("agt_nonexistent");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AgentError);
        expect((err as InstanceType<typeof AgentError>).statusCode).toBe(404);
      }
    });
  });

  describe("stopAgent", () => {
    it("should stop a running agent", async () => {
      const agent = await manager.createAgent({ cwd: "/tmp" });
      expect(agent.status).toBe("running");

      const stopped = await manager.stopAgent(agent.id, { force: true });
      expect(stopped.status).toBe("stopped");
    });

    it("should be a no-op for already stopped agent", async () => {
      const agent = await manager.createAgent({ cwd: "/tmp" });
      await manager.stopAgent(agent.id, { force: true });

      const result = await manager.stopAgent(agent.id);
      expect(result.status).toBe("stopped");
    });
  });

  describe("reconcileAgents", () => {
    it("should mark agents as stopped when tmux session is gone", async () => {
      const agent = await manager.createAgent({ cwd: "/tmp" });

      // Now make tmux report no session
      const { runCommand } = await import("../../src/lib/run-command.js");
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
        const agent = await manager.createAgent({ cwd: "/tmp" });

        const { runCommand } = await import("../../src/lib/run-command.js");
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
});
