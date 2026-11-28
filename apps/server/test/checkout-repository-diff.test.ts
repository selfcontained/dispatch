import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { json } from "node:stream/consumers";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sessionFromWire } from "@dispatch/runner-protocol/contract";
import { BindingStore } from "../../../packages/runner/src/local/bindings.js";
import { checkoutHandlers } from "../../../packages/runner/src/core/checkout.js";
import { streamCheckoutRead } from "../../../packages/runner/src/workload/agents/remote/runner.js";
import { enrolledCheckouts } from "../../../packages/runner/src/workload/agents/remote/checkout-operations.js";
import { checkoutWorkload } from "./helpers/checkout-workload.js";

let root: string;
let checkout: string;
const session = sessionFromWire("agt_repository_diff");
const target = { session, checkout: "current" as const };
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "repository-diff-"));
  git(root, "init", "--quiet", "--initial-branch=master");
  await writeFile(path.join(root, "README"), "original\n");
  git(root, "add", ".");
  git(
    root,
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "--quiet",
    "-m",
    "base"
  );
  checkout = path.join(root, "worktree");
  git(
    root,
    "worktree",
    "add",
    "--quiet",
    "--no-track",
    "-b",
    "feature",
    checkout,
    "master"
  );
  await writeFile(
    path.join(checkout, "README"),
    "original\nuncommitted edit\n"
  );
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

it.each(["local", "enrolled"] as const)(
  "compares a master-default repository-worktree through %s without a saved base",
  async (lane) => {
    const store = new BindingStore(path.join(root, "state"));
    await store.import([
      {
        session: String(session),
        path: checkout,
        currentPath: null,
        worktree: null,
      },
    ]);
    const local = checkoutHandlers(store, { workload: checkoutWorkload });
    const remote = enrolledCheckouts(
      {
        checkoutDirectory: async () => checkout,
      } as never,
      {
        read: (directory, selection: any) =>
          streamCheckoutRead(
            [
              "bun",
              "-e",
              `import {runCheckoutWorker} from ${JSON.stringify(new URL("../../../packages/runner/src/workload/agents/checkout-worker.ts", import.meta.url).href)}; await runCheckoutWorker(["read",process.argv[1]], {});`,
              directory,
            ],
            process.env,
            JSON.stringify(selection),
            new AbortController().signal
          ),
      } as never,
      new AbortController().signal
    );
    const call = async (
      op: "checkout.diff" | "checkout.stats" | "checkout.changes",
      uncommitted = true
    ) => {
      const input = {
        target,
        base: null,
        uncommitted,
        whitespace: "show" as const,
        exclude: [],
      };
      if (lane === "local") return (local[op] as any)(input, {});
      return (
        (await json(
          await remote.checkoutRead(op, input, new AbortController().signal)
        )) as any
      ).data;
    };
    expect(await call("checkout.diff")).toMatchObject({
      files: [{ path: "README", added: 1 }],
    });
    expect(await call("checkout.stats")).toMatchObject({
      files: 1,
      added: 1,
      deleted: 0,
    });
    expect(await call("checkout.diff", false)).toMatchObject({ files: [] });
    expect(await call("checkout.changes")).toMatchObject({
      baseRef: "master",
      files: ["README"],
    });
  }
);
