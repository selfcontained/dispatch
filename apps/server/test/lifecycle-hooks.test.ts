import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
});
