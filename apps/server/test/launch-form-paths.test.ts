import Fastify from "fastify";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerSystemRoutes } from "../src/routes/system.js";
import * as command from "../../../packages/runner/src/workload/shared/lib/run-command.js";
import * as privacy from "../src/shared/mac-path-privacy.js";

let app: ReturnType<typeof Fastify>;
let home: string;
beforeEach(async () => {
  app = Fastify();
  await registerSystemRoutes(app, {} as never);
  home = await mkdtemp(path.join(os.tmpdir(), "launch-form-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  await rm(home, { recursive: true, force: true });
});

const info = (raw: string) =>
  app.inject({ url: "/api/v1/system/path-info", query: { path: raw } });
const complete = (raw: string) =>
  app.inject({
    url: "/api/v1/system/path-completions",
    query: { prefix: raw },
  });
const facts = (
  resolvedPath: string,
  exists = false,
  isDirectory = false,
  isGitRepo = false,
  privacyRestricted = false
) =>
  JSON.stringify({
    exists,
    isDirectory,
    isGitRepo,
    privacyRestricted,
    resolvedPath,
  });

it("returns main's path facts and preserves the typed path through symlinks", async () => {
  const repo = path.join(home, "repo");
  await mkdir(repo);
  execFileSync("git", ["init", "-q", repo]);
  const link = path.join(home, "link");
  await symlink(repo, link);
  await writeFile(path.join(home, "file"), "fixture");
  expect((await info(" relative ")).body).toBe(facts("relative"));
  expect((await info("~/missing")).body).toBe(
    facts(path.join(home, "missing"))
  );
  expect((await info("~/file")).body).toBe(
    facts(path.join(home, "file"), true)
  );
  expect((await info(" ~ ")).body).toBe(facts(home, true, true));
  const run = vi.spyOn(command, "runCommand");
  expect((await info(" ~/link ")).body).toBe(facts(link, true, true, true));
  expect(run).toHaveBeenCalledWith(
    "git",
    ["-C", link, "rev-parse", "--is-inside-work-tree"],
    { timeoutMs: 3000, allowedExitCodes: [0, 1, 128] }
  );
  run.mockRejectedValueOnce(new Error("git timed out"));
  expect((await info(link)).body).toBe(facts(link));
});

it("skips protected automatic probes before inspecting the directory", async () => {
  const protectedPath = path.join(home, "Documents");
  await mkdir(protectedPath);
  await mkdir(path.join(protectedPath, "visible-if-read"));
  vi.spyOn(privacy, "shouldSkipAutomaticMacPathProbe").mockImplementation(
    (candidate, root) => privacy.isMacProtectedPath(candidate, root, "darwin")
  );
  const run = vi.spyOn(command, "runCommand");
  expect((await info("~/Documents")).body).toBe(
    facts(protectedPath, false, false, false, true)
  );
  expect((await complete("~/Documents/v")).body).toBe(
    '{"completions":[],"privacyRestricted":true}'
  );
  expect(run).not.toHaveBeenCalled();
});

it("completes directories using main's filtering, ordering, limit and tilde spelling", async () => {
  const names = Array.from(
    { length: 24 },
    (_, n) => "Alpha" + String(n).padStart(2, "0")
  );
  for (const name of [...names, ".hidden"]) await mkdir(path.join(home, name));
  await symlink(path.join(home, names[0]!), path.join(home, "ALink"));
  await writeFile(path.join(home, "AFile"), "fixture");
  const result = (completions: string[]) =>
    JSON.stringify({ completions, privacyRestricted: false });
  expect((await complete("relative/")).body).toBe('{"completions":[]}');
  expect((await complete(" ~/aLp ")).body).toBe(
    result(names.slice(0, 20).map((name) => "~/" + name))
  );
  expect((await complete(home + "/")).body).toBe(
    result(names.slice(0, 20).map((name) => path.join(home, name)))
  );
  expect((await complete("~/.h")).body).toBe(result(["~/.hidden"]));
  expect((await complete("~/absent/")).body).toBe(result([]));
});

it.each([
  ["system/path-info", "path"],
  ["system/path-completions", "prefix"],
  ["git/branches", "cwd"],
])("rejects a blank or absent %s query with main's 400", async (route, key) => {
  for (const query of [{}, { [key!]: " " }]) {
    const res = await app.inject({ url: "/api/v1/" + route, query });
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe(
      JSON.stringify({ error: key + " query parameter is required." })
    );
  }
});

it("lists the repository default first and returns the existing 500 on failure", async () => {
  const run = vi.spyOn(command, "runCommand").mockResolvedValueOnce({
    exitCode: 0,
    stdout:
      "aaa\trefs/heads/topic\naaa\trefs/heads/master\naaa\trefs/heads/alpha\naaa\trefs/heads/main\n",
    stderr: "",
  });
  run.mockResolvedValueOnce({
    exitCode: 0,
    stdout: "origin/master",
    stderr: "",
  });
  const request = () =>
    app.inject({ url: "/api/v1/git/branches", query: { cwd: " ~ " } });
  expect((await request()).body).toBe(
    '{"branches":["master","alpha","main","topic"]}'
  );
  expect(run).toHaveBeenCalledWith(
    "git",
    ["-C", home, "ls-remote", "--heads", "origin"],
    { timeoutMs: 15000 }
  );
  run.mockRejectedValueOnce(new Error("fixture unavailable"));
  const failed = await request();
  expect(failed.statusCode).toBe(500);
  expect(failed.body).toBe('{"error":"Failed to list remote branches."}');
});
