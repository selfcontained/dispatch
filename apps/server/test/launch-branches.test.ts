import { registerLaunchTargetRoutes } from "../src/routes/launch-targets.js";
import { runnerDirectory } from "../src/runners/directory.js";
import { placementForRunner } from "../src/runners/placement.js";
import {
  RunnerCallError,
  type Runner,
  type Runners,
} from "@dispatch/runner-protocol/contract";
import { checkoutWorkload } from "../src/agents/checkout-worker.js";
import Fastify from "fastify";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registerSystemRoutes } from "../src/routes/system.js";
import { listLocalRemoteBranches } from "../src/agents/local-workspace-probes.js";
import * as commands from "../src/shared/lib/run-command.js";

const roots: string[] = [];
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function repository(defaultBranch: string, count: number, detached = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), "launch-branches-"));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.com",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.com",
      },
    }).trim();
  git("init", "-b", defaultBranch);
  writeFileSync(path.join(root, "file"), "fixture");
  git("add", "file");
  git("commit", "-m", "fixture");
  const head = git("rev-parse", "HEAD");
  execFileSync("git", ["update-ref", "--stdin"], {
    cwd: root,
    input: Array.from(
      { length: count },
      (_, i) => `create refs/heads/topic-${i} ${head}\n`
    ).join(""),
  });
  git("remote", "add", "origin", root);
  if (detached) git("checkout", "--detach");
  return root;
}
async function setup(runners: Pick<Runners, "for"> = runnerDirectory({})) {
  const app = Fastify();
  apps.push(app);
  await registerSystemRoutes(app, {} as never);
  app.get("/api/runners", async () => ({ runners: [] }));
  await registerLaunchTargetRoutes(app, {
    runners,
    templates: {} as never,
    tasks: {} as never,
  });
  return app;
}
it.each([
  ["main", 2, false],
  ["master", 2, false],
  ["develop", 2, false],
  ["develop", 150, false],
  ["develop", 2, true],
] as const)(
  "pins main's branch response for %s with %i heads (detached=%s)",
  async (base, count, detached) => {
    const root = repository(base, count, detached);
    const app = await setup();
    const command = vi.spyOn(commands, "runCommand");
    const expected = await listLocalRemoteBranches(root);
    const response = await app.inject(
      `/api/v1/git/branches?cwd=${encodeURIComponent(root)}`
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(JSON.stringify(expected));
    expect(expected.branches).toHaveLength(count + 1);
    expect(command).toHaveBeenCalledWith(
      "git",
      ["-C", root, "ls-remote", "--heads", "origin"],
      { timeoutMs: 15000 }
    );
  }
);
it("pins main's missing directory and failure bytes", async () => {
  const app = await setup();
  const missing = await app.inject("/api/v1/git/branches");
  expect(missing.statusCode).toBe(400);
  expect(missing.body).toBe('{"error":"cwd query parameter is required."}');
  vi.spyOn(commands, "runCommand").mockRejectedValue(
    new Error("fixture failure")
  );
  const failed = await app.inject("/api/v1/git/branches?cwd=%2Fmissing");
  expect(failed.statusCode).toBe(500);
  expect(failed.body).toBe('{"error":"Failed to list remote branches."}');
});

async function branchUrl(app: ReturnType<typeof Fastify>, directory?: string) {
  const target = (await app.inject("/api/v1/launch-targets")).json().targets[0];
  return `${target.dataUrl}/branches${directory ? `?directory=${encodeURIComponent(directory)}` : ""}`;
}
it.each([
  ["master", 2, false],
  ["develop", 2, false],
  ["develop", 150, false],
  ["develop", 2, true],
] as const)(
  "matches main's names and order through the runner for %s with %i heads (detached=%s)",
  async (base, count, detached) => {
    const root = repository(base, count, detached);
    const app = await setup();
    const expected = await listLocalRemoteBranches(root);
    const response = await app.inject(await branchUrl(app, root));
    expect(response.statusCode).toBe(200);
    expect(response.json().branches).toEqual(expected.branches);
    expect(response.json().defaultBranch).toBe(detached ? undefined : base);
  }
);
it.each(["absent", "not-ready", "ready", "unavailable", "unknown_outcome"])(
  "serves path branches with child state %s",
  async (state) => {
    const root = repository("master", 2);
    const call = vi.fn(async (_op, input) => {
      if (state !== "ready")
        throw new RunnerCallError({
          code: state as "unavailable" | "unknown_outcome",
          message: "fixture transport",
        });
      return checkoutWorkload.run(
        "git.branches",
        { directory: root, request: {} },
        {}
      );
    });
    const child =
      state === "absent"
        ? undefined
        : ({
            connection: {
              state: state === "not-ready" ? "unavailable" : "ready",
            },
            call,
          } as unknown as Runner);
    const app = await setup(runnerDirectory({ child: () => child }));
    const response = await app.inject(await branchUrl(app, root));
    expect(response.statusCode).toBe(200);
    expect(response.json().branches).toEqual(
      (await listLocalRemoteBranches(root)).branches
    );
    expect(call).toHaveBeenCalledTimes(
      ["absent", "not-ready"].includes(state) ? 0 : 1
    );
  }
);
it("maps branch read and timeout failures as main does and rejects a missing folder", async () => {
  const app = await setup();
  const missing = await app.inject(await branchUrl(app));
  expect(missing.statusCode).toBe(400);
  expect(missing.body).toBe('{"error":"cwd query parameter is required."}');
  vi.spyOn(commands, "runCommand").mockRejectedValue(
    Object.assign(new Error("fixture timeout"), { code: "ETIMEDOUT" })
  );
  const response = await app.inject(await branchUrl(app, "/missing"));
  expect(response.statusCode).toBe(500);
  expect(response.body).toBe('{"error":"Failed to list remote branches."}');
});
it("routes repository branches on an unbound enrolled adapter through the same operation", async () => {
  const listRepositoryBranches = vi.fn(async () => ({
    branches: ["one", "two"],
    defaultBranch: "two",
  }));
  const directory = runnerDirectory({
    remote: { listRepositoryBranches } as never,
  });
  expect(
    await directory.for(placementForRunner("fixture")).call("git.branches", {
      target: { repository: "https://github.com/org/repo" },
    })
  ).toEqual({ branches: ["one", "two"], defaultBranch: "two" });
  expect(listRepositoryBranches).toHaveBeenCalledWith("fixture", {
    repository: "https://github.com/org/repo",
  });
});
