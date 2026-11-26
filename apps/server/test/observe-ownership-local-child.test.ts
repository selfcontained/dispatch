/*
 * The conformance scenario for `workspace.observe` with `policy: "ownership"`
 * on this machine's runner: the real local child (the reference core), with
 * a managed checkout prepared from a repository, as the remote lane runs it
 * on an enrolled runner. Both runners answer the same contract.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionFromWire } from "@dispatch/runner-protocol/contract";
import {
  checked,
  workspaceObserveOwnership,
} from "@dispatch/runner-conformance";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  startTestLocalRunner,
  type TestLocalRunner,
} from "./helpers/local-runner-child.js";

let root: string;
let bare: string;
let child: TestLocalRunner;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "observe-ownership-")));
  const work = join(root, "work");
  bare = join(root, "origin.git");
  await mkdir(work);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
  git(work, "init", "-q", "-b", "main");
  git(work, "config", "user.email", "t@example.test");
  git(work, "config", "user.name", "T");
  await writeFile(join(work, "a.txt"), "a\n");
  git(work, "add", ".");
  git(work, "commit", "-qm", "base");
  execFileSync("git", ["clone", "-q", "--bare", work, bare]);
  await mkdir(join(root, "state"));
  child = startTestLocalRunner(join(root, "state"));
  await child.ready();
}, 60_000);

afterAll(async () => {
  await child?.stop();
  await rm(root, { recursive: true, force: true });
});

it("the local child reads no checkout state for an ownership observation", async () => {
  const runner = checked(child.session);
  await expect(
    workspaceObserveOwnership.run({
      runner,
      session: sessionFromWire("observe-ownership-fixture"),
      async seed() {},
      workspace: {
        runner,
        repository: `file://${bare}`,
        async interrupt() {},
        async proveIsolation() {},
        async proveRelease() {},
      },
    })
  ).resolves.toBeUndefined();
}, 60_000);
