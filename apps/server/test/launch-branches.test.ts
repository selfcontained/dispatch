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
async function setup() {
  const app = Fastify();
  apps.push(app);
  await registerSystemRoutes(app, {} as never);
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
