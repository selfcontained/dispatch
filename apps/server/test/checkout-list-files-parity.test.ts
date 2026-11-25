/*
 * A local agent's checkout file listing (`listFiles`, owner reviews' and
 * personas' reads) answers as main's in-process `inspectCheckout` does, with
 * no child, and through a real child that serves it.
 */
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pathFromWire,
  sessionFromWire,
} from "@dispatch/runner-protocol/contract";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inspectCheckout } from "../src/agents/checkout-inspection.js";
import { inspectAgentCheckout } from "../src/agents/checkout-runner.js";
import { localCheckoutWorkload } from "../src/runners/local.js";
import { controllerPlacement } from "../src/runners/placement.js";
import type { AgentRecord } from "../src/agents/types.js";
import {
  startTestLocalRunner,
  type TestLocalRunner,
} from "./helpers/local-runner-child.js";

const agentId = "agt_listfiles1";
let root: string;
let repo: string;
let moved: string;
let child: TestLocalRunner;

const agent = (workspacePath: string | null = null) =>
  ({
    id: agentId,
    cwd: repo,
    worktreePath: null,
    workspacePath,
    placement: controllerPlacement,
  }) as unknown as AgentRecord;

/** Main: the agent's own folder, read in process. */
const main = (dir: string, path: string) =>
  inspectCheckout(dir, { kind: "listFiles", path }).then(
    (reply) => ({ reply }),
    (error: Error & { status?: number; statusCode?: number }) => ({
      error: [error.constructor.name, error.message, error.status ?? null],
    })
  );

const now = (
  path: string,
  runners?: Parameters<typeof inspectAgentCheckout>[2],
  workspacePath: string | null = null
) =>
  inspectAgentCheckout(
    agent(workspacePath),
    { kind: "listFiles", path },
    runners
  ).then(
    (reply) => ({ reply }),
    (error: Error & { status?: number; statusCode?: number }) => ({
      error: [error.constructor.name, error.message, error.status ?? null],
    })
  );

/** Valid folders, answered by main's in-process read. */
/** The runners the manager passes: its own, with the child. */
const viaChild = { local: undefined, child: () => child.session };

const paths = [".agents/personas", "src", "src/deep", "missing", ".git"];
/** Not a checkout folder: refused before any read, as today. */
const invalid = ["", "../outside", "src/../a", "./src"];

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "list-files-")));
  repo = join(root, "repo");
  moved = join(root, "elsewhere");
  await mkdir(join(repo, ".agents", "personas"), { recursive: true });
  await mkdir(join(repo, "src", "deep"), { recursive: true });
  await mkdir(moved);
  execFileSync("git", ["init", "-q", repo]);
  await writeFile(join(repo, "a.txt"), "a");
  await writeFile(join(repo, ".hidden"), "h");
  await writeFile(join(repo, ".agents", "personas", "review.md"), "r");
  await writeFile(join(repo, "src", "b.ts"), "b");
  await symlink(join(repo, "a.txt"), join(repo, "src", "link.txt"));
  await symlink(join(repo, "nowhere"), join(repo, "src", "dangling.txt"));
  await mkdir(join(moved, "notes"));
  await writeFile(join(moved, "notes", "c.md"), "c");
  await mkdir(join(root, "state"));
  child = startTestLocalRunner(join(root, "state"));
  await child.ready();
  await child.session.call("runner.describe", {});
  await child.session.call("workspace.prepare", {
    session: sessionFromWire(agentId),
    source: { directory: pathFromWire(repo) },
    copyIgnored: [],
    installDependencies: false,
  });
}, 60_000);

afterAll(async () => {
  await child?.stop();
  await rm(root, { recursive: true, force: true });
});

describe("listFiles for a local agent", () => {
  it.each(paths)(
    "%j answers as main's in-process read, with no child",
    async (path) => {
      expect(await now(path)).toEqual(await main(repo, path));
    }
  );

  it.each(paths)("%j answers as main's, from a real child", async (path) => {
    const here = vi.spyOn(localCheckoutWorkload, "run");
    try {
      expect(await now(path, viaChild)).toEqual(await main(repo, path));
    } finally {
      here.mockRestore();
    }
  });

  it("lists the moved workspace, as main lists the agent's current folder", async () => {
    expect(await now("notes", undefined, moved)).toEqual(
      await main(moved, "notes")
    );
    expect(await now("notes", viaChild, moved)).toEqual(
      await main(moved, "notes")
    );
  });

  it.each(invalid)(
    "%j is refused as an invalid query, as today",
    async (path) => {
      for (const runners of [undefined, viaChild])
        expect(await now(path, runners)).toEqual({
          error: ["AgentError", "Invalid checkout query.", null],
        });
    }
  );
});

describe("listFiles through the agent's runner", () => {
  it("is served by a healthy child: nothing runs here", async () => {
    const here = vi.spyOn(localCheckoutWorkload, "run");
    try {
      expect(await now("src", viaChild)).toEqual(await main(repo, "src"));
      expect(here).not.toHaveBeenCalled();
    } finally {
      here.mockRestore();
    }
  });
});
