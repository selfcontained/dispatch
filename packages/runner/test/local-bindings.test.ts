/*
 * The one-time binding import in the real child: this test process is the
 * parent, the runner is a real bun process on a temp state root, and every
 * checkout is a real Git repository or worktree in a temp directory. Each
 * ownership row of the truth table has its own assertion, so a flip fails.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import {
  superviseRunner,
  type LaunchedRunner,
  type LauncherBinding,
  type RunnerSupervisor,
} from "@dispatch/runner-client/launcher";
import { callLocalSocket } from "@dispatch/runner-client/transport/local-socket";
import { BINDINGS_DIR, type StoredBinding } from "../src/local/bindings.js";

const entry = fileURLToPath(
  new URL("./fixtures/runner-entry.ts", import.meta.url)
);
const bun = process.env.BUN_BINARY ?? "bun";
const build = { version: "0.0.0-test" };

const supervisors: RunnerSupervisor[] = [];
const temps: string[] = [];

function temp(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await supervisor.stop(2_000);
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();

/** Start one runner; resolves with its first ready child. */
function start(root: string, frozen = false) {
  return new Promise<LaunchedRunner>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("No ready runner")),
      10_000
    );
    const supervisor = superviseRunner({
      command: [bun, entry, "local-runner"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        RUNNER_TEST_BUILD: JSON.stringify(build),
      },
      start: {
        build,
        roots: { state: root, files: root },
        config: { runnerId: "local", displayName: "Local", engines: [] },
      },
      backoff: { initialMs: 50, maxMs: 200 },
      frozen: () => frozen,
      onState(state) {
        if (state.state !== "ready") return;
        clearTimeout(timer);
        resolve(state.runner);
      },
    });
    supervisors.push(supervisor);
  });
}

const stored = (root: string, session: string): StoredBinding | null => {
  const file = join(
    root,
    BINDINGS_DIR,
    `${createHash("sha256").update(session).digest("hex")}.json`
  );
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as StoredBinding)
    : null;
};
const ownership = (root: string, session: string) =>
  stored(root, session)?.checkout.ownership;

/** Every file under `root` with its size and modification time. */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else out[path.slice(root.length)] = `${stat.size}:${stat.mtimeMs}`;
    }
  };
  walk(root);
  return out;
}

const binding = (
  session: string,
  path: string,
  worktree?: { path: string; branch?: string; base?: string },
  currentPath: string | null = null
): LauncherBinding => ({
  session,
  path,
  currentPath,
  worktree: worktree
    ? {
        path: worktree.path,
        branch: worktree.branch ?? null,
        base: worktree.base ?? null,
      }
    : null,
});

// One repository with the checkouts every row needs, made once.
let repo: string;
let work: string;
const wt = (name: string) => join(work, name);

beforeAll(() => {
  work = temp("local-bindings-repos-");
  repo = join(work, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  for (const name of ["created", "moved", "deleted", "switched", "archiving"])
    git(repo, "worktree", "add", "-q", "-b", `b-${name}`, wt(name));
  git(wt("switched"), "checkout", "-q", "-b", "b-switched-later");
  mkdirSync(join(wt("created"), "sub"));
  rmSync(wt("deleted"), { recursive: true, force: true }); // Not pruned.
  mkdirSync(join(work, "plain"));
  mkdirSync(join(work, "elsewhere"));
  symlinkSync(wt("archiving"), join(work, "link-to-archiving"));
});

describe("one-time binding import (real child, real Git)", () => {
  it("decides ownership per row: owned only for a claimed linked worktree root, unknown is external, missing is gone", async () => {
    const root = temp("local-bindings-state-");
    const runner = await start(root);
    const answer = await runner.importBindings(
      [
        // Main-created worktree: main's archive removes it.
        binding("created", wt("created"), {
          path: wt("created"),
          branch: "b-created",
          base: "main",
        }),
        // Plain folder (no worktree on the row).
        binding("plain", join(work, "plain")),
        // A linked worktree the row did not create (a reviewer in another
        // session's worktree): main never removes it for this session.
        binding("borrower", wt("created")),
        // The repository's own checkout as a plain folder.
        binding("folder-repo", repo),
        // Moved workspace: the launch worktree stays owned, the move is a path.
        binding(
          "moved",
          wt("moved"),
          { path: wt("moved"), branch: "b-moved" },
          join(work, "elsewhere")
        ),
        // Deleted directory, with Git still listing the worktree.
        binding("deleted", wt("deleted"), {
          path: wt("deleted"),
          branch: "b-deleted",
        }),
        // Deleted plain folder.
        binding("deleted-plain", join(work, "never-existed")),
        // Changed branch: the recorded branch is kept.
        binding("switched", wt("switched"), {
          path: wt("switched"),
          branch: "b-switched",
          base: "main",
        }),
        // A pending archive is a row like any other, reached through a link.
        binding("archiving", join(work, "link-to-archiving"), {
          path: join(work, "link-to-archiving"),
          branch: "b-archiving",
        }),
        // Contradictory claims: never owned.
        binding("claims-primary", repo, { path: repo, branch: "main" }),
        binding("claims-subdir", join(wt("created"), "sub"), {
          path: join(wt("created"), "sub"),
        }),
        binding("claims-not-git", join(work, "plain"), {
          path: join(work, "plain"),
        }),
        binding("claims-relative", "relative/path", { path: "relative/path" }),
        binding("claims-file", join(repo, "a.txt"), {
          path: join(repo, "a.txt"),
        }),
        // Malformed entries are counted, never stored.
        { session: "", path: "/x", currentPath: null, worktree: null },
        { session: "bad" } as unknown as LauncherBinding,
      ],
      10_000
    );
    expect(answer).toMatchObject({
      type: "imported",
      added: 14,
      kept: 0,
      invalid: 2,
      frozen: false,
    });

    expect(ownership(root, "created")).toBe("owned");
    expect(ownership(root, "plain")).toBe("external");
    expect(ownership(root, "folder-repo")).toBe("external");
    expect(ownership(root, "borrower")).toBe("external");
    expect(ownership(root, "moved")).toBe("owned");
    expect(stored(root, "moved")).toMatchObject({
      path: wt("moved"),
      currentPath: join(work, "elsewhere"),
      checkout: { path: wt("moved") },
    });
    expect(ownership(root, "deleted")).toBe("gone");
    expect(ownership(root, "deleted-plain")).toBe("gone");
    expect(ownership(root, "switched")).toBe("owned");
    expect(stored(root, "switched")?.checkout).toMatchObject({
      branch: "b-switched",
      base: "main",
    });
    expect(ownership(root, "archiving")).toBe("owned");
    expect(ownership(root, "claims-primary")).toBe("external");
    expect(ownership(root, "claims-subdir")).toBe("external");
    expect(ownership(root, "claims-not-git")).toBe("external");
    expect(ownership(root, "claims-relative")).toBe("external");
    expect(ownership(root, "claims-file")).toBe("external");
    expect(stored(root, "bad")).toBeNull();
    expect(stored(root, "created")).toEqual({
      version: 1,
      session: "created",
      path: wt("created"),
      currentPath: null,
      checkout: {
        path: wt("created"),
        ownership: "owned",
        branch: "b-created",
        base: "main",
      },
      source: "import",
    });
  });

  it("a second import never replaces a binding; rollback then upgrade adds only the new sessions", async () => {
    const root = temp("local-bindings-state-");
    const runner = await start(root);
    const first = [
      binding("a", wt("created"), { path: wt("created"), branch: "b-created" }),
      binding("b", join(work, "plain")),
    ];
    expect(await runner.importBindings(first, 10_000)).toMatchObject({
      added: 2,
      kept: 0,
    });
    const before = tree(root);
    // Repeating it at the next start changes no byte.
    expect(await runner.importBindings(first, 10_000)).toMatchObject({
      added: 0,
      kept: 2,
    });
    expect(tree(root)).toEqual(before);

    // Rolled back to main, which moved b and started c; then upgraded again
    // with a new child on the same state root.
    await supervisors.pop()!.stop(2_000);
    const again = await start(root);
    const answer = await again.importBindings(
      [
        binding("b", join(work, "plain"), undefined, join(work, "elsewhere")),
        binding("c", wt("moved"), { path: wt("moved"), branch: "b-moved" }),
        binding("c", join(work, "plain")), // A repeat in one list: first wins.
      ],
      10_000
    );
    expect(answer).toMatchObject({ added: 1, kept: 2, invalid: 0 });
    expect(stored(root, "a")?.checkout.ownership).toBe("owned");
    expect(stored(root, "b")).toMatchObject({
      currentPath: null,
      checkout: { ownership: "external" },
    });
    expect(ownership(root, "c")).toBe("owned");
    for (const [file, value] of Object.entries(before))
      expect(tree(root)[file]).toBe(value);
  });

  it("a frozen runner stores nothing and says so; after thaw the same import lands", async () => {
    const root = temp("local-bindings-state-");
    const runner = await start(root, true);
    expect(runner.ready.frozen).toBe(true);
    const before = tree(root);
    const list = [binding("f", join(work, "plain"))];
    expect(await runner.importBindings(list, 10_000)).toMatchObject({
      added: 0,
      kept: 0,
      frozen: true,
    });
    expect(tree(root)).toEqual(before);
    expect(existsSync(join(root, BINDINGS_DIR))).toBe(false);

    await runner.fence(false, 5_000);
    expect(await runner.importBindings(list, 10_000)).toMatchObject({
      added: 1,
      frozen: false,
    });
    // Freezing again: a later import is refused again.
    await runner.fence(true, 5_000);
    const frozenTree = tree(root);
    expect(
      await runner.importBindings([binding("g", join(work, "plain"))], 10_000)
    ).toMatchObject({ added: 0, frozen: true });
    expect(tree(root)).toEqual(frozenTree);
  });

  it("import is a launcher message only: the socket refuses it as an operation", async () => {
    const root = temp("local-bindings-state-");
    const runner = await start(root);
    for (const op of ["import", "launcher.import", "workspace.import"]) {
      const error = await callLocalSocket(
        runner.ready.socket,
        runner.ready.nonce,
        op as "runner.health",
        { bindings: [binding("s", join(work, "plain"))] } as never
      ).then(
        () => null,
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(RunnerCallError);
      expect((error as RunnerCallError).code).toBe("unsupported");
    }
    expect(existsSync(join(root, BINDINGS_DIR))).toBe(false);
  });
});
