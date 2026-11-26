import { Readable } from "node:stream";
import { json } from "node:stream/consumers";
import {
  MANAGED_WORKSPACE,
  isCheckoutReadRequest,
} from "@dispatch/runner-protocol";
import { sessionFromWire } from "@dispatch/runner-protocol/contract";
import { enrolledCheckouts } from "../../../../packages/runner/src/workload/agents/remote/checkout-operations.js";
import { createSessionCore } from "@dispatch/runner/cli";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Req, Res } from "@dispatch/runner-protocol/contract";
import type { createCheckoutWorkload } from "../../../../packages/runner/src/workload/agents/checkout-worker.js";
import { buildMergeRiskEvidence } from "../../src/agents/merge-risk/evidence.js";
import {
  loadCodeowners,
  parseCodeowners,
  type CodeownersConfig,
} from "./codeowners.js";
import {
  createSessionSupervisor,
  runnerStorageKey,
} from "../../../../packages/runner/src/workload/agents/remote/session-supervisor.js";
import type { SessionProcesses } from "../../../../packages/runner/src/workload/agents/remote/session-processes.js";
import { streamHelper } from "./stream-helper.js";

export function ownerEvidence(owners: CodeownersConfig | null) {
  return buildMergeRiskEvidence({
    pullRequest: {
      number: 1,
      title: "Fixture",
      body: "",
      baseRef: "main",
      headRef: "topic",
      additions: 1,
      deletions: 0,
    },
    files: [{ path: "src/service.ts", additions: 1, deletions: 0 }],
    owners,
    reviews: [],
    briefing: "",
    ci: { status: "unknown" },
  } as never).change_summary.subsystems;
}
export function ownerReply(reply: Res<"checkout.read">) {
  return reply ? parseCodeowners(reply.data) : null;
}
export async function ownedCheckoutFixture(
  workload: ReturnType<typeof createCheckoutWorkload>
) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "owned-read-"))
  );
  const repo = path.join(root, "repo"),
    worktree = path.join(root, "worktree"),
    moved = path.join(root, "moved"),
    plain = path.join(root, "plain"),
    gone = path.join(root, "gone");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
  const owners = async (dir: string, persona: string) => {
    await mkdir(path.join(dir, ".agents"), { recursive: true });
    await writeFile(
      path.join(dir, ".agents/owners.json"),
      JSON.stringify({
        version: 1,
        rules: [{ paths: ["src/**"], personas: [persona] }],
      })
    );
  };
  const seed = async (dir: string, persona: string) => {
    await mkdir(dir);
    git(dir, "init", "--quiet", "--initial-branch=main");
    await owners(dir, persona);
    git(dir, "add", ".");
    git(
      dir,
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--quiet",
      "-m",
      "pin"
    );
  };
  await seed(repo, "main-owner");
  await seed(moved, "moved-owner");
  await owners(plain, "folder-owner");
  git(repo, "worktree", "add", "--quiet", "-b", "work", worktree);
  await owners(worktree, "worktree-owner");
  git(repo, "worktree", "add", "--quiet", "-b", "gone", gone);
  await mkdir(path.join(moved, "sub"));
  const rows = [
    {
      name: "worktree",
      cwd: repo,
      worktreePath: worktree,
      workspacePath: null,
      expected: { "worktree-owner": 1 },
    },
    {
      name: "no-worktree",
      cwd: repo,
      worktreePath: null,
      workspacePath: null,
      expected: { "main-owner": 1 },
    },
    {
      name: "moved-repository",
      cwd: repo,
      worktreePath: worktree,
      workspacePath: moved,
      expected: { "worktree-owner": 1 },
    },
    {
      name: "moved-subfolder",
      cwd: repo,
      worktreePath: worktree,
      workspacePath: path.join(moved, "sub"),
      expected: { "worktree-owner": 1 },
    },
    {
      name: "gone-worktree",
      cwd: repo,
      worktreePath: gone,
      workspacePath: moved,
      expected: {},
    },
    {
      name: "non-repository",
      cwd: plain,
      worktreePath: null,
      workspacePath: null,
      expected: { "folder-owner": 1 },
    },
  ].map((r, i) => ({
    ...r,
    id: `agt_owned${i}`,
    worktreeBranch: "work",
    baseBranch: "main",
    home: r.worktreePath ?? r.cwd,
  }));
  const state = path.join(root, "enrolled");
  const processes: SessionProcesses = {
    acquire: () => () => {},
    alive: () => false,
    stop: async () => {},
    cleanup: async () => {},
    cleanupLegacy: async () => {},
    socketInUse: () => false,
    socketMatchesHost: () => true,
    spawn: async () => {
      throw new Error("No host runs in this read fixture.");
    },
  };
  const create = () =>
    createSessionSupervisor(
      {
        state,
        streamHelper,
        sessions: createSessionCore,
        build: { version: "test", revision: "a".repeat(40) },
        uid: process.getuid!(),
        gid: process.getgid!(),
        ca: path.join(root, "unused-ca"),
        bins: { claudeBin: "", codexBin: "" },
        env: {},
        hostCommand: () => ["/unused-host"],
        asWorkload: async (bin, args) =>
          bin === "realpath"
            ? (await realpath(args.at(-1)!)) + "\n"
            : execFileSync(bin, args, {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
              }),
      },
      processes
    );
  let supervisor = await create();
  for (const row of rows) {
    const key = runnerStorageKey(row.id),
      bindings = path.join(state, "bindings");
    await writeFile(path.join(bindings, key), "\0folder");
    await writeFile(path.join(bindings, `${key}.cwd`), row.home);
    if (row.workspacePath)
      await supervisor.sessionCheckout(row.id, MANAGED_WORKSPACE, {
        kind: "select",
        path: row.workspacePath,
      });
  }
  return {
    root,
    repo,
    worktree,
    moved,
    plain,
    gone,
    rows,
    async operation<K extends "checkout.access" | "checkout.read">(
      op: K,
      row: (typeof rows)[number],
      input: Req<K>
    ) {
      const signal = new AbortController().signal;
      const handlers = enrolledCheckouts(
        supervisor,
        {
          async run() {
            throw new Error("Unexpected checkout query");
          },
          async manifest() {
            throw new Error("Unexpected command manifest");
          },
          read(directory, selection) {
            if (
              !isCheckoutReadRequest(selection, row.id) ||
              !(
                selection.op === "checkout.access" ||
                selection.op === "checkout.read"
              )
            )
              throw new Error("Unexpected checkout worker input");
            return Readable.from(
              (async function* () {
                const data = await workload.run(
                  selection.op,
                  { directory, request: selection.request },
                  {}
                );
                yield Buffer.from(JSON.stringify({ data }));
              })()
            );
          },
        },
        signal
      );
      if (
        !("session" in input.target) ||
        input.target.session !== sessionFromWire(row.id)
      )
        throw new Error("Wrong checkout session");
      const reply = (await json(
        await handlers.checkoutRead(op, input, signal)
      )) as { data: Res<K> };
      return reply.data;
    },
    async finalizeGone() {
      await rm(gone, { recursive: true, force: true });
    },
    async main(row: (typeof rows)[number]) {
      return ownerEvidence(await loadCodeowners(row.home).catch(() => null));
    },
    async read(
      row: (typeof rows)[number],
      checkout: "current" | "launch",
      request: Omit<Req<"checkout.read">, "target"> = {
        path: ".agents/owners.json",
        encoding: "utf8",
        maxBytes: null,
      }
    ) {
      const directory = await supervisor.checkoutDirectory(
        row.id,
        MANAGED_WORKSPACE,
        checkout
      );
      return workload.run("checkout.read", { directory, request }, {});
    },
    async access(
      row: (typeof rows)[number],
      checkout: "current" | "launch",
      request: Omit<Req<"checkout.access">, "target">
    ) {
      const directory = await supervisor.checkoutDirectory(
        row.id,
        MANAGED_WORKSPACE,
        checkout
      );
      return workload.run("checkout.access", { directory, request }, {});
    },
    async direct(row: (typeof rows)[number]) {
      return workload.run(
        "checkout.read",
        {
          directory: row.home,
          request: {
            path: ".agents/owners.json",
            encoding: "utf8",
            maxBytes: null,
          },
        },
        {}
      );
    },
    async restart() {
      supervisor.close();
      supervisor = await create();
    },
    async stored(row: (typeof rows)[number]) {
      return readFile(
        path.join(state, "bindings", `${runnerStorageKey(row.id)}.cwd`),
        "utf8"
      );
    },
    async close() {
      supervisor.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
