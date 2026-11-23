/*
 * A local launch folder through the runner interface (`path.resolve`): the
 * local adapter asks the child when it is ready, and runs the same port in
 * process when there is no child or it dies mid-call. The app answers with
 * main's messages, and a failed Git probe stays a failed probe.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  pathFromWire,
  RunnerCallError,
  type Res,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import { runnerDirectory } from "../src/runners/directory.js";
import { controllerPlacement } from "../src/runners/placement.js";
import { launchDirectory } from "../src/agents/workspace-launch.js";

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
    expect(call).toHaveBeenCalledWith(
      "path.resolve",
      { path: "/child/answers" },
      undefined
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
