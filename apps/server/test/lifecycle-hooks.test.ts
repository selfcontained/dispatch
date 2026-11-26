import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { previewArchive } from "../src/agents/archive.js";
import { runLifecycleHook } from "../src/agents/lifecycle-hooks.js";
import type { AgentRecord } from "../src/agents/types.js";

const logger = {
  info: () => {},
  warn: () => {},
} as unknown as import("fastify").FastifyBaseLogger;

async function repoWithStopHook(dir: string): Promise<void> {
  await mkdir(path.join(dir, ".dispatch"), { recursive: true });
  await writeFile(
    path.join(dir, ".dispatch", "tools.json"),
    JSON.stringify({
      hooks: {
        stop: { command: ["sh", "-c", 'echo "$DISPATCH_AGENT_ID" > stopped'] },
      },
    })
  );
}

describe("runLifecycleHook", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "dispatch-hooks-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("runs the stop hook in the launch checkout and the moved workspace", async () => {
    const launch = path.join(root, "launch");
    const moved = path.join(root, "moved");
    await repoWithStopHook(launch);
    await repoWithStopHook(moved);

    await runLifecycleHook(
      "stop",
      {
        id: "agt_hook",
        cwd: launch,
        worktreePath: launch,
        workspacePath: moved,
      } as AgentRecord,
      logger
    );

    await expect(readFile(path.join(launch, "stopped"), "utf8")).resolves.toBe(
      "agt_hook\n"
    );
    await expect(readFile(path.join(moved, "stopped"), "utf8")).resolves.toBe(
      "agt_hook\n"
    );
  });

  it("runs once when the agent never moved", async () => {
    const launch = path.join(root, "launch");
    await repoWithStopHook(launch);
    await writeFile(
      path.join(launch, ".dispatch", "tools.json"),
      JSON.stringify({
        hooks: { stop: { command: ["sh", "-c", "echo x >> stopped"] } },
      })
    );

    await runLifecycleHook(
      "stop",
      {
        id: "agt_hook",
        cwd: launch,
        worktreePath: null,
        workspacePath: null,
      } as AgentRecord,
      logger
    );

    await expect(readFile(path.join(launch, "stopped"), "utf8")).resolves.toBe(
      "x\n"
    );
  });

  it("uses the launch checkout's archive hook for an older worktree", async () => {
    const launch = path.join(root, "launch");
    const worktree = path.join(root, "worktree");
    await repoWithStopHook(worktree);
    await mkdir(path.join(launch, ".dispatch"), { recursive: true });
    await writeFile(
      path.join(launch, ".dispatch", "tools.json"),
      JSON.stringify({
        hooks: {
          archive: {
            command: ["sh", "-c", 'echo "$DISPATCH_AGENT_ID" > archived'],
          },
        },
      })
    );

    await runLifecycleHook(
      "archive",
      {
        id: "agt_hook",
        cwd: worktree,
        launchCwd: launch,
        worktreePath: worktree,
      } as AgentRecord,
      logger
    );

    await expect(readFile(path.join(launch, "archived"), "utf8")).resolves.toBe(
      "agt_hook\n"
    );
  });

  it("previews configured cascade cleanup without running hooks", async () => {
    const plain = path.join(root, "plain");
    const configured = path.join(root, "configured");
    await repoWithStopHook(plain);
    await mkdir(path.join(configured, ".dispatch"), { recursive: true });
    const description =
      "Permanently deletes the owned isolated dev database and logs.";
    await writeFile(
      path.join(configured, ".dispatch", "tools.json"),
      JSON.stringify({
        hooks: {
          archive: {
            command: ["sh", "-c", "echo wiped > archived"],
            description,
          },
        },
      })
    );
    const agents = new Map<string, AgentRecord>([
      ["parent", { id: "parent", cwd: plain } as AgentRecord],
      [
        "child",
        {
          id: "child",
          cwd: plain,
          worktreePath: plain,
          launchCwd: configured,
        } as AgentRecord,
      ],
    ]);
    const getRequiredAgent = vi.fn(async (id: string) => agents.get(id)!);
    const pool = {
      query: vi.fn(async (_sql: string, [id]: [string]) => ({
        rows: id === "parent" ? [{ id: "child" }] : [],
      })),
    } as unknown as Pool;

    await expect(
      previewArchive({ pool, getRequiredAgent }, "parent")
    ).resolves.toEqual({
      worktreeStatus: null,
      subAgentCount: 1,
      cleanupDescriptions: [description],
    });
    await expect(
      readFile(path.join(configured, "archived"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
