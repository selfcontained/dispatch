/*
 * The core's preparation from a repository, over the real socket with a
 * port that runs real Git against a local bare remote: one cached clone per
 * repository whatever the URL's spelling, every checkout kind, tags, the
 * receipt and the binding's ownership, and what is refused.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionFromWire, type Req } from "@dispatch/runner-protocol/contract";
import { LocalSocketConnection } from "@dispatch/runner-client/transport/local-socket";
import { BindingStore } from "../src/local/bindings.js";
import { WriteFence } from "../src/local/fence.js";
import { serveSocket } from "../src/local/socket-server.js";
import { workspaceHandlers } from "../src/core/workspace.js";
import {
  repositoryIdentity,
  repositoryKey,
  storableUrl,
} from "../src/core/repository.js";
import type { WorkspacePort } from "../src/platform/types.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const run of cleanups.splice(0).reverse()) run();
});
const temp = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "core-repository-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
const commit = (cwd: string, message: string) =>
  git(
    cwd,
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@example.test",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    message
  );

/** A bare remote with `main` (tagged v1), a `topic` branch and a pull request ref. */
function remote(root: string) {
  const work = join(root, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  commit(work, "first");
  git(work, "tag", "v1");
  git(work, "branch", "topic");
  git(work, "checkout", "-q", "-b", "contrib");
  commit(work, "contribution");
  const head = git(work, "rev-parse", "HEAD");
  git(work, "checkout", "-q", "main");
  const bare = join(root, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", work, bare]);
  git(bare, "update-ref", "refs/pull/7/head", head);
  git(bare, "branch", "-D", "contrib");
  return { work, bare, head };
}

/**
 * A real port: worktrees beside the source (or where the platform's
 * `location` said), from origin when it has the base; real clones.
 */
function port(
  calls: string[],
  withRepository = true,
  location?: (session: string) => Promise<string>
): WorkspacePort {
  const where = (directory: string, branch: string) =>
    join(
      dirname(directory),
      `${basename(directory)}-${branch.replace(/\//g, "-")}`
    );
  const hasRef = (cwd: string, ref: string) => {
    try {
      git(cwd, "rev-parse", "-q", "--verify", ref);
      return true;
    } catch {
      return false;
    }
  };
  return {
    async canonical(path) {
      return existsSync(path) && statSync(path).isDirectory()
        ? realpathSync(path)
        : null;
    },
    async identity(path) {
      if (!existsSync(path)) return null;
      const s = statSync(path, { bigint: true });
      return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
    },
    async plan(spec) {
      calls.push(`plan ${spec.branch} ${spec.base} ${spec.create}`);
      const path = spec.at ?? where(spec.directory, spec.branch);
      const taken = spec.at
        ? readdirSync(spec.at).length > 0
        : existsSync(path);
      return { path, branch: spec.branch, taken };
    },
    async create(spec, path) {
      calls.push(`create ${basename(path)}`);
      const base = hasRef(spec.directory, `origin/${spec.base}`)
        ? `origin/${spec.base}`
        : spec.base;
      git(
        spec.directory,
        "worktree",
        "add",
        "-q",
        ...(spec.create
          ? ["--no-track", "-b", spec.branch, path, base]
          : [path, spec.branch])
      );
      return { path, branch: spec.branch };
    },
    async copyIgnored() {
      calls.push("copy");
      return [];
    },
    async installDependencies(_directory, report) {
      calls.push("install");
      await report({ status: "done", detail: "nothing to install" });
    },
    async locate(path) {
      return existsSync(path) ? { directory: realpathSync(path) } : "missing";
    },
    async git(directory) {
      let top: string;
      try {
        top = git(directory, "rev-parse", "--show-toplevel");
      } catch {
        return null;
      }
      return {
        repoRoot: top,
        branch: git(directory, "branch", "--show-current"),
        worktreePath: top,
        worktreeName: basename(top),
        isWorktree: true,
      };
    },
    ...(withRepository && {
      repository: {
        async cache(url, cache, clone) {
          calls.push(`cache ${url}`);
          mkdirSync(cache, { recursive: true });
          if (existsSync(clone)) {
            git(clone, "remote", "set-url", "origin", url);
            git(
              clone,
              "fetch",
              "-q",
              "--prune",
              "origin",
              "+refs/heads/*:refs/remotes/origin/*",
              "+refs/tags/*:refs/tags/*"
            );
          } else {
            const partial = `${clone}.partial`;
            execFileSync("git", ["clone", "-q", "--no-checkout", url, partial]);
            const branch = git(partial, "symbolic-ref", "--short", "HEAD");
            git(
              partial,
              "update-ref",
              "--no-deref",
              "HEAD",
              git(partial, "rev-parse", "HEAD")
            );
            git(partial, "branch", "-D", branch);
            renameSync(partial, clone);
          }
          const head = git(
            clone,
            "symbolic-ref",
            "--short",
            "refs/remotes/origin/HEAD"
          );
          return { defaultBranch: head.replace(/^origin\//, "") };
        },
        async pullRequest(clone, number, branch) {
          calls.push(`pull ${number} ${branch}`);
          git(clone, "fetch", "-q", "origin", `refs/pull/${number}/head`);
          git(clone, "branch", "--no-track", branch, "FETCH_HEAD");
        },
        ...(location && { location }),
      },
    }),
    async madeForUs(path, source, branch) {
      calls.push(`made? ${basename(path)}`);
      try {
        return (
          git(path, "rev-parse", "--show-toplevel") === path &&
          git(
            path,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir"
          ) ===
            git(
              source,
              "rev-parse",
              "--path-format=absolute",
              "--git-common-dir"
            ) &&
          git(path, "symbolic-ref", "--short", "-q", "HEAD") === branch
        );
      } catch {
        return false;
      }
    },
  };
}

async function harness(
  withRepository = true,
  location?: (session: string) => Promise<string>
) {
  const root = temp();
  const state = join(root, "state");
  mkdirSync(state);
  const store = new BindingStore(state);
  const calls: string[] = [];
  const socket = join(root, "r.sock");
  const nonce = randomBytes(8).toString("hex");
  const server = await serveSocket(
    socket,
    nonce,
    {
      calls: workspaceHandlers(
        state,
        store,
        port(calls, withRepository, location),
        join(root, "cache")
      ),
    },
    new WriteFence(false)
  );
  const connection = await LocalSocketConnection.connect({ socket, nonce });
  cleanups.push(() => {
    connection.close();
    server.close();
  });
  return { root, state, store, calls, connection };
}

type Checkout = Extract<
  Req<"workspace.prepare">["source"],
  { repository: string }
>["checkout"];
const request = (
  session: string,
  repository: string,
  checkout: Checkout
): Req<"workspace.prepare"> => ({
  session: sessionFromWire(session),
  source: { repository, checkout },
  copyIgnored: [".env"],
  installDependencies: true,
});

describe("repository identity", () => {
  it("is one per repository, whatever the spelling", () => {
    const same = [
      "https://user:secret@GitHub.com/o/r.git",
      "https://github.com/o/r/",
      "ssh://git@github.com/o/r.git",
      "git@github.com:o/r.git",
      "github.com:o/r",
    ].map(repositoryIdentity);
    expect(new Set(same)).toEqual(new Set(["github.com/o/r"]));
    expect(repositoryIdentity("https://github.com/o/fork")).not.toBe(
      "github.com/o/r"
    );
    expect(repositoryIdentity("/srv/git/r.git")).toBe("file/srv/git/r");
    expect(repositoryIdentity("file:///srv/git/r")).toBe("file/srv/git/r");
    for (const bad of ["", "not a url", "https://host/", "/"])
      expect(repositoryIdentity(bad)).toBeNull();
    expect(repositoryKey("github.com/o/r")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never stores HTTP credentials", () => {
    expect(storableUrl("https://user:secret@host/o/r.git")).toBe(
      "https://host/o/r.git"
    );
    expect(storableUrl("git@host:o/r.git")).toBe("git@host:o/r.git");
  });
});

describe("workspace.prepare from a repository", () => {
  it("clones once, makes a new branch from the default base, with tags, and binds it as owned", async () => {
    const { root, connection, store, calls, state } = await harness();
    const { bare } = remote(root);
    const events: unknown[] = [];
    const binding = await connection.call(
      "workspace.prepare",
      request("n", bare, { kind: "new", branch: "feature/n" }),
      { onEvent: (event) => events.push(event) }
    );
    const key = repositoryKey(repositoryIdentity(bare)!);
    const clone = join(root, "cache", key, "origin");
    const made = `${clone}-feature-n`;
    expect(binding).toMatchObject({
      path: made,
      worktree: { path: made, branch: "feature/n", base: "main" },
      git: { branch: "feature/n" },
    });
    expect(events).toEqual([
      { phase: "workspace" },
      { phase: "workspace" },
      { phase: "copy" },
      { phase: "dependencies" },
      { phase: "dependencies", status: "done", detail: "nothing to install" },
      { phase: "ready" },
    ]);
    expect(calls.slice(0, 2)).toEqual([
      `cache ${bare}`,
      "plan feature/n main true",
    ]);
    // Tags come with the clone, so `git describe` works in the checkout.
    expect(git(made, "describe", "--tags")).toBe("v1");
    expect(await store.get("n")).toMatchObject({
      checkout: { path: made, ownership: "owned", branch: "feature/n" },
      source: "prepare",
    });
    const receipt = JSON.parse(
      readFileSync(join(state, "n", "workspace-preparation"), "utf8")
    );
    expect(receipt).toMatchObject({
      source: clone,
      repository: {
        identity: repositoryIdentity(bare),
        checkout: { kind: "new", branch: "feature/n" },
        url: bare,
      },
      worktree: { path: made, complete: true },
    });
    expect(receipt.at).toBeUndefined();

    // A repeat answers from the record without touching the clone.
    calls.length = 0;
    await connection.call(
      "workspace.prepare",
      request("n", bare, { kind: "new", branch: "feature/n" })
    );
    expect(calls).toEqual([]);
    await expect(
      connection.call(
        "workspace.prepare",
        request("n", bare, { kind: "new", branch: "other" })
      )
    ).rejects.toMatchObject({
      code: "conflict",
      message: "This launch already owns a different worktree.",
    });
  });

  it("shares one clone across spellings and fetches what is new", async () => {
    const { root, connection, calls } = await harness();
    const { bare, work } = remote(root);
    await connection.call(
      "workspace.prepare",
      request("a", bare, { kind: "branch", branch: "topic" })
    );
    commit(work, "later");
    git(work, "tag", "v2");
    git(work, "push", "-q", bare, "main", "v2");
    const binding = await connection.call(
      "workspace.prepare",
      request("b", `file://${bare}/`, { kind: "default" })
    );
    expect(readdirSync(join(root, "cache"))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith("cache "))).toEqual([
      `cache ${bare}`,
      `cache file://${bare}/`,
    ]);
    expect(binding.worktree).toMatchObject({ branch: "main", base: "main" });
    expect(git(pathOf(binding), "describe", "--tags")).toBe("v2");
  });

  it("checks out an existing branch and a pull request head", async () => {
    const { root, connection, calls } = await harness();
    const { bare, head } = remote(root);
    const topic = await connection.call(
      "workspace.prepare",
      request("t", bare, { kind: "branch", branch: "topic" })
    );
    expect(topic.worktree).toMatchObject({ branch: "topic", base: "topic" });
    const pr = await connection.call(
      "workspace.prepare",
      request("p", bare, { kind: "pr", branch: "contrib", number: 7 })
    );
    expect(calls).toContain("pull 7 contrib");
    expect(pr.worktree).toMatchObject({ branch: "contrib" });
    expect(git(pathOf(pr), "rev-parse", "HEAD")).toBe(head);
  });

  it("finishes a recorded preparation on resume", async () => {
    const { root, connection, state } = await harness();
    const { bare } = remote(root);
    const first = await connection.call(
      "workspace.prepare",
      request("r", bare, { kind: "new", branch: "r" })
    );
    // As if the binding was never written: resume binds the same checkout.
    const receipt = join(state, "r", "workspace-preparation");
    const recorded = JSON.parse(readFileSync(receipt, "utf8"));
    writeFileSync(
      receipt,
      JSON.stringify({
        ...recorded,
        worktree: { ...recorded.worktree, complete: false },
      })
    );
    const resumed = await connection.call("workspace.resume", {
      session: sessionFromWire("r"),
    });
    expect(resumed?.worktree).toEqual(first.worktree);
  });

  it("refuses what it cannot prepare", async () => {
    const plain = await harness(false);
    await expect(
      plain.connection.call(
        "workspace.prepare",
        request("u", "https://host/o/r", { kind: "default" })
      )
    ).rejects.toMatchObject({ code: "unsupported" });
    const { connection, root } = await harness();
    await expect(
      connection.call(
        "workspace.prepare",
        request("i", "not a url", { kind: "default" })
      )
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      connection.call("workspace.prepare", {
        ...request("c", join(root, "x.git"), { kind: "default" }),
        copyIgnored: ["a/b"],
      })
    ).rejects.toMatchObject({ code: "invalid" });
    expect(existsSync(join(root, "cache"))).toBe(false);
  });
});

describe("workspace.prepare at the platform's location", () => {
  /** What `linux-privsep` does: a fixed, empty checkout per session. */
  const sessions =
    (root: string, made: string[]) => async (session: string) => {
      made.push(session);
      const dir = join(root, "sessions", session, "checkout");
      mkdirSync(dir, { recursive: true });
      return dir;
    };

  it("makes the worktree where the platform says and records the place", async () => {
    const made: string[] = [];
    const root = temp();
    const {
      connection,
      store,
      state,
      calls,
      root: home,
    } = await harness(true, sessions(root, made));
    const { bare } = remote(root);
    const at = join(root, "sessions", "p", "checkout");
    const binding = await connection.call(
      "workspace.prepare",
      request("p", bare, { kind: "new", branch: "feature/p" })
    );
    expect(binding).toMatchObject({
      path: at,
      worktree: { path: at, branch: "feature/p", base: "main" },
    });
    expect(git(at, "rev-parse", "--show-toplevel")).toBe(at);
    expect(git(at, "describe", "--tags")).toBe("v1");
    const receipt = JSON.parse(
      readFileSync(join(state, "p", "workspace-preparation"), "utf8")
    );
    expect(receipt).toMatchObject({ at, worktree: { path: at } });
    expect(await store.get("p")).toMatchObject({
      checkout: { path: at, ownership: "owned" },
    });
    // Asked once for the new receipt, once more before Git ran.
    expect(made).toEqual(["p", "p"]);
    // Nothing beside the clone.
    const key = repositoryKey(repositoryIdentity(bare)!);
    expect(readdirSync(join(home, "cache", key))).toEqual(["origin"]);
    expect(calls).not.toContain("made? checkout");
  });

  it("takes over a worktree a crash left at the location, asking the platform", async () => {
    const made: string[] = [];
    const root = temp();
    const { connection, state, calls } = await harness(
      true,
      sessions(root, made)
    );
    const { bare } = remote(root);
    await connection.call(
      "workspace.prepare",
      request("q", bare, { kind: "branch", branch: "topic" })
    );
    // Back to "Git made it, the receipt only says pending".
    const file = join(state, "q", "workspace-preparation");
    const receipt = JSON.parse(readFileSync(file, "utf8"));
    const { worktree, ...rest } = receipt;
    writeFileSync(
      file,
      JSON.stringify({
        ...rest,
        pending: { path: worktree.path, branch: worktree.branch },
      })
    );
    calls.length = 0;
    const resumed = await connection.call("workspace.resume", {
      session: sessionFromWire("q"),
    });
    expect(resumed).toMatchObject({ worktree: { path: worktree.path } });
    expect(calls).toContain("made? checkout");
    expect(calls.some((call) => call.startsWith("create"))).toBe(false);
  });

  it("refuses when the platform's place moved since it was recorded", async () => {
    const root = temp();
    let n = 0;
    const { connection, state } = await harness(true, async (session) => {
      const dir = join(root, `sessions-${n++}`, session, "checkout");
      mkdirSync(dir, { recursive: true });
      return dir;
    });
    const { bare } = remote(root);
    await expect(
      connection.call(
        "workspace.prepare",
        request("m", bare, { kind: "branch", branch: "topic" })
      )
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      JSON.parse(
        readFileSync(join(state, "m", "workspace-preparation"), "utf8")
      ).worktree
    ).toBeUndefined();
  });
});

function pathOf(binding: { path: unknown }) {
  return binding.path as string;
}
