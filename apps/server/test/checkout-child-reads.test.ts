/*
 * T09: checkout reads for a local agent go Dispatch → Runners → the local
 * runner session → the child's socket → the core → the workload. The child
 * here is the real socket server, core handlers, binding store and workload,
 * in this process; every read is compared with the in-process path (what
 * main does) byte for byte.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RunnerCallError,
  runnerIdFromWire,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import type { CheckoutQuery, CheckoutView } from "@dispatch/runner-protocol";
import { LocalRunnerSession } from "@dispatch/runner-client/session";
import { serveSocket } from "../../../packages/runner/src/local/socket-server.js";
import { BindingStore } from "../../../packages/runner/src/local/bindings.js";
import { WriteFence } from "../../../packages/runner/src/local/fence.js";
import {
  checkoutHandlers,
  checkoutOpens,
} from "../../../packages/runner/src/core/checkout.js";
import { checkoutWorkload } from "./helpers/checkout-workload.js";
import {
  inspectAgentCheckout,
  readAgentStats,
  readAgentView,
  sessionRunner,
  target,
} from "../src/agents/checkout-runner.js";
import { readCheckoutView } from "../../../packages/runner/src/workload/agents/checkout-view.js";
import { inspectCheckout } from "./helpers/checkout-inspection.js";
import { controllerPlacement } from "../src/runners/placement.js";
import { runnerDirectory } from "../src/runners/directory.js";
import { detectAgentIcon, readAgentIcon } from "../src/agents/checkout-icon.js";
import { pathFromWire } from "@dispatch/runner-protocol/contract";
import type { AgentRecord } from "../src/agents/types.js";

const dirs: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });

let repo: string;
let moved: string;
let socket: { close(): void };
let session: LocalRunnerSession;
let fence: WriteFence;
let childRuns = 0;
const bound = "agt_bound";
const PNG_OLD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const PNG_NEW = Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 5, 6, 7]);

const agent = (id: string, extra: Partial<AgentRecord> = {}) =>
  ({
    id,
    cwd: repo,
    worktreePath: null,
    workspacePath: null,
    baseBranch: "main",
    placement: controllerPlacement,
    gitContext: null,
    ...extra,
  }) as AgentRecord;

const noCommands = {
  requestSession: () => {
    throw new Error("not used");
  },
};
const runners = () => ({
  local: noCommands,
  child: (): Runner => session,
});

beforeAll(async () => {
  repo = temp("child-reads-repo-");
  git(repo, "init", "-q", "-b", "main");
  await mkdir(path.join(repo, "src"));
  await writeFile(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(path.join(repo, ".gitignore"), "ignored/\n");
  await writeFile(path.join(repo, "pixel.png"), PNG_OLD);
  await mkdir(path.join(repo, ".agents", "personas"), { recursive: true });
  await writeFile(
    path.join(repo, ".agents", "personas", "critic.md"),
    "---\nname: Critic\n---\nReview it.\n"
  );
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  const origin = temp("child-reads-origin-");
  git(origin, "init", "-q", "--bare", "-b", "main");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "main");
  git(repo, "checkout", "-q", "-b", "work");
  await writeFile(path.join(repo, "src", "a.ts"), "export const a = 2;\n");
  await writeFile(path.join(repo, "pixel.png"), PNG_NEW);
  await mkdir(path.join(repo, "src", "__tests__"));
  await writeFile(path.join(repo, "src", "__tests__", "a.test.ts"), "t\n");
  await writeFile(path.join(repo, "src", "b.spec.ts"), "s\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "work");
  await writeFile(path.join(repo, "notes.md"), "untracked\n");
  await mkdir(path.join(repo, "ignored"));
  await writeFile(path.join(repo, "ignored", "x"), "x\n");
  await symlink(path.join(repo, "src"), path.join(repo, "linked"));
  moved = temp("child-reads-moved-");

  const state = temp("child-reads-state-");
  const store = new BindingStore(state);
  await store.import([
    { session: bound, path: repo, currentPath: null, worktree: null },
  ]);
  fence = new WriteFence(false);
  const workload = {
    run: ((...args: Parameters<typeof checkoutWorkload.run>) => {
      childRuns += 1;
      return checkoutWorkload.run(...args);
    }) as typeof checkoutWorkload.run,
    watch: (...args: Parameters<typeof checkoutWorkload.watch>) => {
      childRuns += 1;
      return checkoutWorkload.watch(...args);
    },
  };
  const runtime = temp("child-reads-sock-");
  const socketPath = path.join(runtime, "s");
  const nonce = randomUUID();
  socket = await serveSocket(
    socketPath,
    nonce,
    {
      calls: checkoutHandlers(store, { workload }),
      opens: checkoutOpens(store, { workload }),
    },
    fence
  );
  session = new LocalRunnerSession({
    description: {
      runnerId: runnerIdFromWire("local"),
      displayName: "Local",
      build: { version: "test" },
      protocol: 1,
      engines: [],
      capabilities: {},
    },
  });
  session.setEndpoint({ socket: socketPath, nonce });
  // Connected, as the app's session is once its child answers describe
  // (this socket serves checkout reads only; any answer is a connection).
  await session.call("runner.describe", {}).catch(() => {});
});

afterAll(() => {
  session?.close();
  socket?.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const views: Array<[string, CheckoutView]> = [
  ["root listing", { kind: "directory", path: "" }],
  ["nested listing", { kind: "directory", path: "src" }],
  ["preview", { kind: "preview", path: "src/a.ts" }],
  ["index", { kind: "index", generation: "g1" }],
  ["stats", { kind: "stats", baseBranch: "main", includeUncommitted: true }],
  [
    "committed stats",
    { kind: "stats", baseBranch: "main", includeUncommitted: false },
  ],
  [
    "diff",
    {
      kind: "diff",
      baseBranch: "main",
      includeUncommitted: true,
      ignoreWhitespace: false,
    },
  ],
  [
    "file diff",
    {
      kind: "fileDiff",
      path: "src/a.ts",
      baseBranch: "main",
      includeUncommitted: true,
      ignoreWhitespace: true,
    },
  ],
  [
    "file diff not in the diff",
    {
      kind: "fileDiff",
      path: "nothing.ts",
      baseBranch: "main",
      includeUncommitted: true,
      ignoreWhitespace: false,
    },
  ],
];

/** The outcome of a read, as a comparable string: value or error. */
async function outcome(read: () => Promise<unknown>) {
  try {
    // The time a computation ran is its only field that may differ.
    return JSON.stringify({ value: await read() }).replace(
      /"computedAt":\d+/g,
      '"computedAt":0'
    );
  } catch (error) {
    const e = error as Error & { statusCode?: number; status?: number };
    return JSON.stringify({
      error: e.constructor.name,
      message: e.message,
      status: e.statusCode ?? e.status ?? null,
    });
  }
}

describe("checkout reads through the local runner child", () => {
  it.each(views)("%s matches the in-process read exactly", async (_, view) => {
    const before = childRuns;
    const viaChild = await outcome(() =>
      readAgentView(agent(bound), view, runners(), "main")
    );
    expect(childRuns).toBe(before + 1);
    const inProcess = await outcome(() =>
      readAgentView(agent(bound), view, undefined, "main")
    );
    expect(viaChild).toBe(inProcess);
  });

  it.each<[string, CheckoutView]>([
    ["a missing file", { kind: "preview", path: "gone.ts" }],
    ["a linked directory", { kind: "directory", path: "linked" }],
    ["a directory preview", { kind: "preview", path: "src" }],
  ])("answers %s with main's error", async (_, view) => {
    const viaChild = await outcome(() =>
      readAgentView(agent(bound), view, runners(), "main")
    );
    expect(viaChild).toBe(
      await outcome(() => readAgentView(agent(bound), view, undefined, "main"))
    );
    expect(JSON.parse(viaChild).error).toBe("WorkspaceError");
  });

  it.each<[string, CheckoutQuery]>([
    ["read", { kind: "readFile", path: "src/a.ts" }],
    ["read missing", { kind: "readFile", path: "src/none.ts" }],
    ["read a directory", { kind: "readFile", path: "src" }],
    ["changes", { kind: "changes", baseBranch: "main" }],
    ["changes with no base", { kind: "changes", baseBranch: null }],
  ])("inspection %s matches the in-process read", async (_, query) => {
    const before = childRuns;
    const viaChild = await outcome(() =>
      inspectAgentCheckout(agent(bound), query, runners())
    );
    expect(childRuns).toBe(before + 1);
    expect(viaChild).toBe(
      await outcome(() => inspectAgentCheckout(agent(bound), query))
    );
  });

  it("diff stats for the refresher match the in-process computation", async () => {
    const viaChild = await readAgentStats(
      bound,
      agent(bound),
      runners(),
      "main"
    );
    const inProcess = await readAgentStats(
      bound,
      agent(bound),
      undefined,
      "main"
    );
    expect(viaChild.kind).toBe("success");
    const strip = (c: typeof viaChild) =>
      JSON.stringify({ ...c, stats: c.stats && { ...c.stats, computedAt: 0 } });
    expect(strip(viaChild)).toBe(strip(inProcess));
    // a.ts, pixel.png, notes.md and the untracked link; the two test files
    // are left out.
    expect(viaChild.stats?.excludingTests).toEqual({
      files: 4,
      added: 3,
      deleted: 2,
    });
  });

  it("reads in process for a session the child holds no binding for", async () => {
    const before = childRuns;
    const view: CheckoutView = { kind: "directory", path: "" };
    expect(
      await outcome(() => readAgentView(agent("agt_new"), view, runners()))
    ).toBe(await outcome(() => readAgentView(agent("agt_new"), view)));
    expect(childRuns).toBe(before);
  });

  it("reads in process when the row moved away from the child's binding", async () => {
    const before = childRuns;
    const row = agent(bound, { workspacePath: moved });
    const view: CheckoutView = { kind: "directory", path: "" };
    expect(await outcome(() => readAgentView(row, view, runners()))).toBe(
      await outcome(() => readAgentView(row, view))
    );
    expect(childRuns).toBe(before);
  });

  it("keeps main's answer for an agent with no workspace", async () => {
    const row = agent(bound, { cwd: null as never });
    for (const view of [views[0]![1], views[6]![1]])
      expect(await outcome(() => readAgentView(row, view, runners()))).toBe(
        await outcome(() => readAgentView(row, view))
      );
    expect(await readAgentView(row, views[4]![1], runners())).toBeNull();
    expect(
      await outcome(() =>
        inspectAgentCheckout(row, { kind: "readFile", path: "a" }, runners())
      )
    ).toBe(
      await outcome(() =>
        inspectAgentCheckout(row, { kind: "readFile", path: "a" })
      )
    );
  });

  it("serves reads while frozen, with Git's optional index refresh off", async () => {
    await fence.freeze();
    try {
      expect(process.env.GIT_OPTIONAL_LOCKS).toBe("0");
      const before = childRuns;
      await readAgentView(agent(bound), views[4]![1], runners(), "main");
      expect(childRuns).toBe(before + 1);
    } finally {
      fence.thaw();
    }
    expect(process.env.GIT_OPTIONAL_LOCKS).toBeUndefined();
  });

  it("carries a reply larger than one socket line on a stream", async () => {
    const big = path.join(repo, "big.txt");
    await writeFile(big, "x".repeat(900 * 1024) + "\n");
    try {
      const view: CheckoutView = {
        kind: "fileDiff",
        path: "big.txt",
        baseBranch: "main",
        includeUncommitted: true,
        ignoreWhitespace: false,
      };
      const viaChild = await outcome(() =>
        readAgentView(agent(bound), view, runners(), "main")
      );
      expect(viaChild.length).toBeGreaterThan(900 * 1024);
      expect(viaChild).toBe(
        await outcome(() =>
          readAgentView(agent(bound), view, undefined, "main")
        )
      );
    } finally {
      rmSync(big);
    }
  });

  it.each<[string, CheckoutView]>([
    [
      "new image",
      {
        kind: "image",
        path: "pixel.png",
        side: "new",
        baseBranch: "main",
        includeUncommitted: true,
      },
    ],
    [
      "old image",
      {
        kind: "image",
        path: "pixel.png",
        side: "old",
        baseBranch: "main",
        includeUncommitted: false,
      },
    ],
    [
      "missing image",
      {
        kind: "image",
        path: "none.png",
        side: "new",
        baseBranch: "main",
        includeUncommitted: true,
      },
    ],
  ])("%s matches main's in-process read", async (_, view) => {
    const before = childRuns;
    const viaChild = await outcome(() =>
      readAgentView(agent(bound), view, runners(), "main")
    );
    expect(childRuns).toBe(before + 1);
    expect(viaChild).toBe(await outcome(() => readCheckoutView(repo, view)));
  });

  it("image bytes are the file's bytes", async () => {
    const view = {
      kind: "image",
      path: "pixel.png",
      side: "new",
      baseBranch: "main",
      includeUncommitted: true,
    } as const;
    const bytes = await readAgentView(agent(bound), view, runners(), "main");
    expect(Buffer.from(bytes as string, "base64")).toEqual(PNG_NEW);
  });

  it("default-branch files match main's in-process read", async () => {
    const query: CheckoutQuery = {
      kind: "defaultBranchFiles",
      directories: [".agents/personas"],
      waitForRefresh: true,
    };
    const before = childRuns;
    const viaChild = await inspectAgentCheckout(agent(bound), query, runners());
    expect(childRuns).toBe(before + 1);
    expect(viaChild).toMatchObject({
      kind: "defaultBranchFiles",
      hasOrigin: true,
      files: [
        {
          path: ".agents/personas/critic.md",
          content: "---\nname: Critic\n---\nReview it.\n",
        },
      ],
    });
    expect(JSON.stringify(viaChild)).toBe(
      JSON.stringify(
        await inspectCheckout(repo, query, {
          recordedBase: false,
          unresolvedBase: "origin/main",
        })
      )
    );
  });

  it("watches the checkout through the child, a pulse per burst", async () => {
    const before = childRuns;
    const { channel } = await sessionRunner(runners(), agent(bound)).open(
      "checkout.watch",
      { target: target(agent(bound)) }
    );
    expect(childRuns).toBe(before + 1);
    let pulses = 0;
    channel.onData(() => pulses++);
    try {
      // One pulse once the watch is set up, then one for this write.
      await expect.poll(() => pulses, { timeout: 5_000 }).toBe(1);
      await writeFile(path.join(repo, "watched.txt"), "changed\n");
      await expect.poll(() => pulses, { timeout: 5_000 }).toBe(2);
    } finally {
      channel.close();
      rmSync(path.join(repo, "watched.txt"), { force: true });
    }
  });

  it("answers in process, as main does, when the child cannot be reached", async () => {
    const closed = new LocalRunnerSession({
      description: session.describe(),
    });
    closed.close();
    for (const [, view] of views)
      expect(
        await outcome(() =>
          readAgentView(
            agent(bound),
            view,
            { local: noCommands, child: () => closed },
            "main"
          )
        )
      ).toBe(
        await outcome(() =>
          readAgentView(agent(bound), view, undefined, "main")
        )
      );
  });

  describe("a folder before any session exists (T15c)", () => {
    const local = (child: Runner | undefined) =>
      runnerDirectory({ child: () => child }).for(controllerPlacement);
    let folder: string;
    beforeAll(async () => {
      folder = temp("child-reads-icon-");
      await mkdir(path.join(folder, "assets"));
      await writeFile(path.join(folder, "assets", "logo.png"), PNG_NEW);
    });
    const at = () => ({ path: pathFromWire(folder) });
    const icon = async (runner: Runner) => {
      const found = await detectAgentIcon(runner, at());
      return {
        found,
        bytes: found ? await readAgentIcon(runner, at(), found) : null,
      };
    };

    it("reads the icon in the child, as the in-process read does", async () => {
      const before = childRuns;
      const viaChild = await icon(local(session));
      expect(childRuns).toBeGreaterThan(before);
      expect(viaChild).toEqual(await icon(local(undefined)));
      expect(viaChild.found).toBe("assets/logo.png");
      expect(viaChild.bytes).toEqual(PNG_NEW);
    });

    it("reads in process when the child is not ready, dies mid-call, or never answers", async () => {
      const closed = new LocalRunnerSession({
        description: session.describe(),
      });
      closed.close();
      const failing = (code: "unavailable" | "unknown_outcome") =>
        ({
          connection: { state: "ready", epoch: 1 },
          call: async () => {
            throw new RunnerCallError({ code, message: code });
          },
        }) as unknown as Runner;
      const expected = await icon(local(undefined));
      for (const child of [
        closed,
        failing("unknown_outcome"),
        failing("unavailable"),
      ])
        expect(await icon(local(child))).toEqual(expected);
    });

    it("keeps a refusal the child answered with", async () => {
      const refusing = {
        connection: { state: "ready", epoch: 1 },
        call: async () => {
          throw new RunnerCallError({ code: "forbidden", message: "no" });
        },
      } as unknown as Runner;
      await expect(
        local(refusing).call("checkout.read", {
          target: at(),
          path: "assets/logo.png",
          encoding: "base64",
          maxBytes: null,
        })
      ).rejects.toMatchObject({ code: "forbidden" });
    });
  });
});
