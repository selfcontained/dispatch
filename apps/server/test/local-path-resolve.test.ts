/*
 * A local launch folder through the runner interface (`path.resolve`): the
 * local adapter asks the child when it is ready, and runs the same port in
 * process when there is no child or it dies mid-call. The app answers with
 * main's messages, and a failed Git probe stays a failed probe.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  pathFromWire,
  RunnerCallError,
  type Res,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import { runnerDirectory } from "../src/runners/directory.js";
import { controllerPlacement } from "../src/runners/placement.js";
import { launchDirectory } from "../src/agents/workspace-launch.js";
import { workspaceWorkload } from "../src/agents/checkout-worker.js";
import { resolveProjectRoot } from "../src/projects/resolve-root.js";

const plain = realpathSync(
  mkdtempSync(path.join(os.tmpdir(), "path-resolve-"))
);
afterAll(() => rmSync(plain, { recursive: true, force: true }));

const reply = (over: Partial<Res<"path.resolve">>): Res<"path.resolve"> => ({
  resolvedPath: pathFromWire(plain),
  canonicalPath: pathFromWire(plain),
  exists: true,
  isDirectory: true,
  isGitRepo: false,
  privacyRestricted: false,
  projectRoot: null,
  git: null,
  ...over,
});

function local(child?: Partial<Runner>) {
  return runnerDirectory({
    child: child ? () => child as Runner : undefined,
  }).for(controllerPlacement);
}

describe("path.resolve on the local runner", () => {
  it("asks a ready child", async () => {
    const call = vi.fn(async () => reply({ isGitRepo: false }));
    const answer = await local({
      call,
      connection: { state: "ready", epoch: 1, onChange: () => () => {} },
    } as never).call("path.resolve", { path: "/child/answers" });
    expect(answer).toEqual(reply({}));
    // One attempt: a child that cannot answer is not waited for.
    expect(call).toHaveBeenCalledWith(
      "path.resolve",
      { path: "/child/answers" },
      { wait: false }
    );
  });

  it.each([
    ["no child", undefined],
    [
      "a child that dies mid-call",
      {
        call: async () => {
          throw new RunnerCallError({ code: "unavailable", message: "gone" });
        },
        connection: { state: "ready", epoch: 1, onChange: () => () => {} },
      },
    ],
  ])("resolves in process with %s", async (_name, child) => {
    expect(
      await local(child as never).call("path.resolve", { path: plain })
    ).toEqual(reply({ git: null }));
  });
});

describe("the app's launch folder from path.resolve", () => {
  it("keeps main's three states", () => {
    expect(launchDirectory(reply({})).git).toEqual({
      status: "ok",
      value: null,
    });
    expect(launchDirectory(reply({ git: null, gitFailed: true })).git).toEqual({
      status: "error",
    });
    expect(
      launchDirectory(
        reply({
          isGitRepo: true,
          git: {
            repoRoot: pathFromWire(plain),
            branch: "main",
            worktreePath: pathFromWire(plain),
            worktreeName: "x",
            isWorktree: false,
          },
        })
      ).git
    ).toMatchObject({ status: "ok", value: { repoRoot: plain } });
  });

  it("refuses with main's messages", () => {
    expect(() =>
      launchDirectory(
        reply({ resolvedPath: pathFromWire("relative"), exists: false })
      )
    ).toThrow("Working directory must be an absolute path.");
    expect(() =>
      launchDirectory(reply({ exists: false, isDirectory: false }))
    ).toThrow("Working directory does not exist or is not a directory.");
  });
});

describe("path.resolve for project matching (the local port)", () => {
  const repo = path.join(plain, "repo");
  const broken = path.join(plain, "broken");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
  beforeAll(() => {
    mkdirSync(path.join(repo, "src"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    mkdirSync(broken);
    git(broken, "init", "-q");
    writeFileSync(path.join(broken, ".git", "config"), "[core\nbad");
  });

  it("adds nothing it was not asked for", async () => {
    const answer = await workspaceWorkload.resolvePath(repo);
    expect(answer).not.toHaveProperty("canonical");
    expect(answer).not.toHaveProperty("projectRootError");
    expect(answer.projectRoot).toBeNull();
  });

  it("resolves the folder's project root and each root, in order, with no Git for roots", async () => {
    const answer = await workspaceWorkload.resolvePath(path.join(repo, "src"), {
      projectRoot: true,
      canonical: [
        path.join(plain, "missing"),
        repo,
        path.join(repo, "src"),
        path.join(plain, "missing"),
      ],
    });
    expect(answer.projectRoot).toBe(repo);
    expect(answer.canonical).toEqual([
      null,
      repo,
      path.join(repo, "src"),
      null,
    ]);
    expect(answer).not.toHaveProperty("projectRootError");
  });

  it("keeps Git's failure for the folder's root as main's own message", async () => {
    const main = await resolveProjectRoot(broken).catch(
      (error: Error) => error.message
    );
    const answer = await workspaceWorkload.resolvePath(broken, {
      projectRoot: true,
      canonical: [broken],
    });
    expect(answer.projectRootError).toBe(main);
    expect(answer.projectRoot).toBeNull();
    // A canonical entry never fails, even in a broken repository.
    expect(answer.canonical).toEqual([broken]);
  });

  it("skips the folder's Git probe when asked", async () => {
    const answer = await workspaceWorkload.resolvePath(broken, { git: false });
    expect(answer).toMatchObject({
      canonicalPath: broken,
      git: null,
      isGitRepo: false,
    });
    expect(answer).not.toHaveProperty("gitFailed");
  });

  it("does no matching work for a folder main refuses", async () => {
    const answer = await workspaceWorkload.resolvePath(
      path.join(plain, "missing"),
      { projectRoot: true, canonical: [repo] }
    );
    expect(answer).toMatchObject({ exists: false });
    expect(answer).not.toHaveProperty("canonical");
    expect(answer).not.toHaveProperty("projectRootError");
  });
});
