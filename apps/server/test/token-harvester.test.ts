import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { cwdToClaudeProjectDir } from "../src/agents/token-harvester.js";

describe("token-harvester", () => {
  describe("cwdToClaudeProjectDir", () => {
    it("encodes a simple path by sanitizing non-alphanumeric path chars", () => {
      const result = cwdToClaudeProjectDir("/Users/brad/dev/apps/dispatch");
      expect(result).toBe(
        path.join(os.homedir(), ".claude", "projects", "-Users-brad-dev-apps-dispatch")
      );
    });

    it("handles nested worktree paths", () => {
      const result = cwdToClaudeProjectDir(
        "/Users/brad/dev/apps/dispatch/.dispatch/worktrees/agt-abc123"
      );
      expect(result).toBe(
        path.join(
          os.homedir(),
          ".claude",
          "projects",
          "-Users-brad-dev-apps-dispatch--dispatch-worktrees-agt-abc123"
        )
      );
    });
  });

  describe("parseSessionTokenUsage (via harvestTokenUsage)", () => {
    // We test the full harvest flow by creating temp JSONL files and a mock pool
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(path.join(os.tmpdir(), "token-harvest-test-"));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("parses assistant entries and accumulates token usage", async () => {
      const sessionId = "test-session-abc";
      const jsonlPath = path.join(tmpDir, `${sessionId}.jsonl`);

      const lines = [
        JSON.stringify({
          type: "user",
          message: { content: "Hello" },
          timestamp: "2026-03-28T10:00:00.000Z",
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-opus-4-6",
            usage: {
              input_tokens: 100,
              cache_creation_input_tokens: 50,
              cache_read_input_tokens: 200,
              output_tokens: 30,
            },
          },
          timestamp: "2026-03-28T10:00:01.000Z",
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-opus-4-6",
            usage: {
              input_tokens: 150,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 300,
              output_tokens: 45,
            },
          },
          timestamp: "2026-03-28T10:00:05.000Z",
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-sonnet-4-6",
            usage: {
              input_tokens: 50,
              cache_creation_input_tokens: 10,
              cache_read_input_tokens: 80,
              output_tokens: 20,
            },
          },
          timestamp: "2026-03-28T10:00:10.000Z",
        }),
      ];

      await writeFile(jsonlPath, lines.join("\n") + "\n");

      const { harvestTokenUsage } = await import("../src/agents/token-harvester.js");

      const upserted: Array<{ params: unknown[] }> = [];
      const mockPool = {
        query: vi.fn(async (_sql: string, params: unknown[]) => {
          upserted.push({ params });
          return { rows: [], rowCount: 0 };
        }),
      };

      // Write JSONL to the claude projects dir that maps to our tmpDir
      const { mkdir } = await import("node:fs/promises");
      const fakeProjectDir = cwdToClaudeProjectDir(tmpDir);
      await mkdir(fakeProjectDir, { recursive: true });
      const realJsonlPath = path.join(fakeProjectDir, `${sessionId}.jsonl`);
      await writeFile(realJsonlPath, lines.join("\n") + "\n");

      await harvestTokenUsage(mockPool as any, {
        id: "agt-test",
        type: "claude" as const,
        cwd: tmpDir,
        worktreePath: null,
      });

      // Should have 2 upserts: one for claude-opus-4-6, one for claude-sonnet-4-6
      expect(mockPool.query).toHaveBeenCalledTimes(2);

      // Find opus upsert
      const opusCall = upserted.find((u) => u.params[2] === "claude-opus-4-6");
      expect(opusCall).toBeDefined();
      expect(opusCall!.params[0]).toBe("agt-test"); // agent_id
      expect(opusCall!.params[1]).toBe(sessionId); // session_id
      expect(opusCall!.params[3]).toBe(250); // input_tokens: 100 + 150
      expect(opusCall!.params[4]).toBe(50); // cache_creation: 50 + 0
      expect(opusCall!.params[5]).toBe(500); // cache_read: 200 + 300
      expect(opusCall!.params[6]).toBe(75); // output_tokens: 30 + 45
      expect(opusCall!.params[7]).toBe(2); // message_count

      // Find sonnet upsert
      const sonnetCall = upserted.find((u) => u.params[2] === "claude-sonnet-4-6");
      expect(sonnetCall).toBeDefined();
      expect(sonnetCall!.params[3]).toBe(50); // input_tokens
      expect(sonnetCall!.params[4]).toBe(10); // cache_creation
      expect(sonnetCall!.params[5]).toBe(80); // cache_read
      expect(sonnetCall!.params[6]).toBe(20); // output_tokens
      expect(sonnetCall!.params[7]).toBe(1); // message_count

      // Clean up the fake project dir
      await rm(fakeProjectDir, { recursive: true, force: true });
    });

    it("silently returns when project dir does not exist", async () => {
      const { harvestTokenUsage } = await import("../src/agents/token-harvester.js");

      const mockPool = {
        query: vi.fn(),
      };

      await harvestTokenUsage(mockPool as any, {
        id: "agt-nonexistent",
        type: "claude" as const,
        cwd: "/nonexistent/path/that/does/not/exist",
        worktreePath: null,
      });

      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it("skips malformed JSON lines", async () => {
      const { harvestTokenUsage } = await import("../src/agents/token-harvester.js");
      const { mkdir } = await import("node:fs/promises");

      const fakeProjectDir = cwdToClaudeProjectDir(tmpDir);
      await mkdir(fakeProjectDir, { recursive: true });

      const sessionId = "malformed-session";
      const jsonlPath = path.join(fakeProjectDir, `${sessionId}.jsonl`);

      const lines = [
        "not valid json",
        JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-opus-4-6",
            usage: {
              input_tokens: 100,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 50,
            },
          },
          timestamp: "2026-03-28T10:00:00.000Z",
        }),
        "", // empty line
      ];

      await writeFile(jsonlPath, lines.join("\n") + "\n");

      const mockPool = {
        query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      };

      await harvestTokenUsage(mockPool as any, {
        id: "agt-malformed",
        type: "claude" as const,
        cwd: tmpDir,
        worktreePath: null,
      });

      // Should still have parsed the valid entry
      expect(mockPool.query).toHaveBeenCalledTimes(1);

      await rm(fakeProjectDir, { recursive: true, force: true });
    });

    it("uses worktreePath when available", async () => {
      const { harvestTokenUsage } = await import("../src/agents/token-harvester.js");
      const { mkdir } = await import("node:fs/promises");

      const worktreeDir = await mkdtemp(path.join(os.tmpdir(), "worktree-test-"));
      const fakeProjectDir = cwdToClaudeProjectDir(worktreeDir);
      await mkdir(fakeProjectDir, { recursive: true });

      const sessionId = "worktree-session";
      const jsonlPath = path.join(fakeProjectDir, `${sessionId}.jsonl`);

      await writeFile(
        jsonlPath,
        JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-opus-4-6",
            usage: { input_tokens: 10, output_tokens: 5 },
          },
          timestamp: "2026-03-28T10:00:00.000Z",
        }) + "\n"
      );

      const mockPool = {
        query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      };

      await harvestTokenUsage(mockPool as any, {
        id: "agt-wt",
        type: "claude" as const,
        cwd: "/original/cwd",
        worktreePath: worktreeDir,
      });

      // Should have used worktreePath (not cwd) for session file discovery
      expect(mockPool.query).toHaveBeenCalledTimes(1);

      await rm(fakeProjectDir, { recursive: true, force: true });
      await rm(worktreeDir, { recursive: true, force: true });
    });

    it("skips opencode agents gracefully", async () => {
      const { harvestTokenUsage } = await import("../src/agents/token-harvester.js");

      const mockPool = { query: vi.fn() };

      await harvestTokenUsage(mockPool as any, {
        id: "agt-opencode",
        type: "opencode" as const,
        cwd: "/some/path",
        worktreePath: null,
      });

      expect(mockPool.query).not.toHaveBeenCalled();
    });
  });

  describe("Codex token harvesting", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(path.join(os.tmpdir(), "codex-harvest-test-"));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("parses Codex rollout token_count events and normalizes cache tokens", async () => {
      const { harvestTokenUsage } = await import("../src/agents/token-harvester.js");
      const { mkdir } = await import("node:fs/promises");

      // Create a fake ~/.codex/sessions/ structure
      const sessionsDir = path.join(os.homedir(), ".codex", "sessions", "test-harvest");
      await mkdir(sessionsDir, { recursive: true });

      const rolloutFile = path.join(sessionsDir, "rollout-test-codex.jsonl");

      const lines = [
        JSON.stringify({
          timestamp: "2026-03-28T10:00:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "[dispatch:agt_codex_test] Say hello" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-28T10:00:01.000Z",
          type: "turn_context",
          payload: { model: "gpt-5.4", cwd: "/tmp" },
        }),
        JSON.stringify({
          timestamp: "2026-03-28T10:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 10000,
                cached_input_tokens: 3000,
                output_tokens: 500,
                total_tokens: 10500,
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-28T10:00:05.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 20000,
                cached_input_tokens: 8000,
                output_tokens: 1200,
                total_tokens: 21200,
              },
            },
          },
        }),
      ];

      await writeFile(rolloutFile, lines.join("\n") + "\n");

      const upserted: Array<{ params: unknown[] }> = [];
      const mockPool = {
        query: vi.fn(async (_sql: string, params: unknown[]) => {
          upserted.push({ params });
          return { rows: [], rowCount: 0 };
        }),
      };

      await harvestTokenUsage(mockPool as any, {
        id: "agt_codex_test",
        type: "codex" as const,
        cwd: "/tmp",
        worktreePath: null,
      });

      expect(mockPool.query).toHaveBeenCalledTimes(1);
      const params = upserted[0].params;
      expect(params[0]).toBe("agt_codex_test"); // agent_id
      expect(params[2]).toBe("gpt-5.4"); // model
      // Normalized: input_tokens - cached = 20000 - 8000 = 12000
      expect(params[3]).toBe(12000); // input_tokens (non-cached)
      expect(params[4]).toBe(0); // cache_creation_tokens (N/A for Codex)
      expect(params[5]).toBe(8000); // cache_read_tokens (= cached_input_tokens)
      expect(params[6]).toBe(1200); // output_tokens
      expect(params[7]).toBe(1); // message_count (session-level)

      // Clean up
      await rm(sessionsDir, { recursive: true, force: true });
    });
  });
});
