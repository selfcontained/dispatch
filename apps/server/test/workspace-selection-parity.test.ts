import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  pathFromWire,
  sessionFromWire,
} from "@dispatch/runner-protocol/contract";
import { runnerDirectory } from "../src/runners/directory.js";
import { controllerPlacement } from "../src/runners/placement.js";
import * as gitContext from "../../../packages/runner/src/workload/shared/git/git-context.js";
import { inferRepositoryUrl } from "../../../packages/runner/src/workload/agents/checkout-worker.js";

it("selects a workspace in process with main's directory, Git, and error semantics", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "workspace-select-"))
  );
  const home = join(root, "home");
  const repo = join(root, "repo");
  const sub = join(repo, "sub");
  const file = join(root, "file");
  const missing = join(root, "missing");
  const id = "agt_selection";
  const runner = runnerDirectory(
    {},
    {
      id,
      cwd: home,
      workspacePath: null,
      worktreePath: null,
      placement: controllerPlacement,
    }
  ).for(controllerPlacement);
  const select = (path: string) =>
    runner.call("workspace.select", {
      session: sessionFromWire(id),
      path: pathFromWire(path),
    });
  const facts = (
    path: string,
    moved: boolean,
    repositoryRoot: string | null
  ) => ({
    path,
    moved,
    origin: null,
    repositoryRoot,
    checkoutRoot: home,
  });
  try {
    await mkdir(home);
    await mkdir(sub, { recursive: true });
    execFileSync("git", ["-C", repo, "init", "-qb", "main"]);
    await writeFile(file, "");
    await expect(inferRepositoryUrl(repo)).rejects.toThrow();
    expect(await select(sub)).toEqual(facts(repo, true, repo));
    expect(await select(home)).toEqual(facts(home, false, null));
    expect(await select(root)).toEqual(facts(root, true, null));
    await expect(select(missing)).rejects.toMatchObject({
      message: missing + " does not exist.",
      statusCode: 400,
    });
    await expect(select(file)).rejects.toMatchObject({
      message: file + " is not a directory.",
      statusCode: 400,
    });
    if (process.platform !== "win32") {
      const unusual = repo + "\\";
      await mkdir(unusual);
      expect(await select(unusual)).toEqual(facts(repo, true, repo));
    }
    vi.spyOn(gitContext, "probeGitContext").mockResolvedValueOnce({
      status: "error",
    });
    await expect(select(repo)).rejects.toMatchObject({
      message: "Could not read git state in " + repo + ".",
      statusCode: 400,
    });
  } finally {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});
