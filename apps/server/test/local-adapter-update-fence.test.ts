import { inProcessPorts } from "../src/runners/in-process.js";
/*
 * The local adapter's mutations honour the app's update fence. The app's own
 * local runner process (supervisor and fence, `startLocalRunnerProcess`)
 * runs the real child; it is frozen, then disconnected from the app's
 * session. While the fence is wanted, a mutation the child cannot take is
 * `fenced` here too and never reaches the in-process port; reads still
 * answer. Thawed, mutations are made again.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  pathFromWire,
  sessionFromWire,
  type Req,
} from "@dispatch/runner-protocol/contract";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { embeddedBuild } from "../src/agents/build-identity.js";
import {
  sessionFilesWorkload,
  workspaceWorkload,
} from "../src/agents/checkout-worker.js";
import { putSessionFile } from "../src/files/session-file.js";
import { runnerDirectory } from "../src/runners/directory.js";
import {
  startLocalRunnerProcess,
  type LocalRunnerProcess,
} from "../src/runners/local.js";
import { controllerPlacement } from "../src/runners/placement.js";

const entry = fileURLToPath(
  new URL("./fixtures/local-runner-entry.ts", import.meta.url)
);
const bun = process.versions.bun
  ? process.execPath
  : (process.env.BUN_BINARY ?? "bun");

const agentId = "agt_fence1";
const session = sessionFromWire(agentId);
let root: string;
let repo: string;
let worktree: string;
let local: LocalRunnerProcess;
let readies = 0;

const row = (worktreePath: string | null = null) => ({
  id: agentId,
  cwd: repo,
  worktreePath,
  workspacePath: null,
  placement: controllerPlacement,
});
const adapter = (worktreePath: string | null = null) =>
  runnerDirectory({ child: () => local.runner }, row(worktreePath)).for(
    controllerPlacement
  );

const outcome = (run: () => Promise<unknown>) =>
  run().then(
    () => "made",
    (error: { code?: string }) => error.code ?? "failed"
  );

/** Each mutation the adapter serves, and what it would have changed. */
const mutations = () => ({
  "checkout.write": () =>
    adapter().call("checkout.write", {
      target: { session, checkout: "current" },
      path: "fenced.txt",
      data: "x",
      expectedDigest: null,
    }),
  "checkout.exec": () =>
    adapter().call("checkout.exec", {
      target: { session, checkout: "current" },
      command: ["touch", "exec-ran.txt"],
      stdin: null,
      timeoutMs: 5_000,
      env: {},
      maxOutputBytes: 1_000,
    } as unknown as Req<"checkout.exec">),
  "workspace.select": () =>
    adapter().call("workspace.select", {
      session,
      path: pathFromWire(join(root, "elsewhere")),
    }),
  "workspace.release": () =>
    adapter(worktree).call("workspace.release", {
      session,
      deleteBranch: false,
      originalBranch: null,
    }),
  "files.put": () =>
    putSessionFile(
      adapter(),
      session,
      join(root, "upload.txt"),
      "upload.txt",
      "prompt"
    ),
});

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "update-fence-")));
  repo = join(root, "repo");
  worktree = join(root, "worktree");
  await mkdir(repo);
  await mkdir(join(root, "elsewhere"));
  await mkdir(worktree);
  execFileSync("git", ["init", "-q", repo]);
  await writeFile(join(repo, "a.txt"), "a");
  await writeFile(join(root, "upload.txt"), "u");
  await mkdir(join(root, "state"));
  const ready = new Promise<void>((resolve) => {
    local = startLocalRunnerProcess({
      stateRoot: join(root, "state"),
      filesRoot: join(root, "state"),
      build: {
        version: embeddedBuild.version,
        revision: embeddedBuild.revision,
      },
      log: { info() {}, warn() {} },
      command: [bun, entry, "local-runner"],
      onReady: () => {
        readies += 1;
        resolve();
      },
    });
  });
  await ready;
  await local.runner.call("workspace.prepare", {
    session,
    source: { directory: pathFromWire(repo) },
    copyIgnored: [],
    installDependencies: false,
  });
}, 60_000);

afterAll(async () => {
  await local?.stop();
  await rm(root, { recursive: true, force: true });
});

describe("mutations while the app's update fence is wanted", () => {
  it("are refused by a frozen child, and here while it is away; reads answer", async () => {
    const here = [
      vi.spyOn(inProcessPorts().checkoutWorkload, "run"),
      vi.spyOn(workspaceWorkload, "release"),
      vi.spyOn(sessionFilesWorkload, "put"),
    ];
    try {
      await local.freeze();
      expect(local.frozen).toBe(true);
      // Reachable and frozen: the child refuses.
      for (const [op, run] of Object.entries(mutations()))
        expect(await outcome(run), op).toBe("fenced");
      // The child is away (disconnected); it would come back frozen.
      local.runner.setEndpoint(null);
      for (const [op, run] of Object.entries(mutations()))
        expect(await outcome(run), op).toBe("fenced");
      for (const spy of here) expect(spy).not.toHaveBeenCalled();
      // Reads are not fenced: they answer here.
      expect(
        await adapter().call("checkout.read", {
          target: { session, checkout: "current" },
          path: "a.txt",
          encoding: "utf8",
          maxBytes: null,
        })
      ).toMatchObject({ data: "a" });
      expect(
        await adapter().call("path.resolve", { path: repo, git: false })
      ).toMatchObject({ exists: true });
      // Thawed: a mutation the child cannot take is made here again.
      await local.thaw();
      expect(local.frozen).toBe(false);
      expect(await outcome(mutations()["checkout.write"])).toBe("made");
      expect(
        here[0]!.mock.calls.filter(([op]) => op === "checkout.write")
      ).toHaveLength(1);
    } finally {
      for (const spy of here) spy.mockRestore();
    }
  }, 60_000);
});
