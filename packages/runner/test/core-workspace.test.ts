/*
 * The core's preparation from a directory, over the real socket with a
 * platform port that runs real Git on temp repositories: the steps and
 * their events, what is recorded and bound, and what is refused.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  pathFromWire,
  sessionFromWire,
  type Req,
} from "@dispatch/runner-protocol/contract";
import { LocalSocketConnection } from "@dispatch/runner-client/transport/local-socket";
import { BindingStore } from "../src/local/bindings.js";
import { WriteFence } from "../src/local/fence.js";
import { serveSocket } from "../src/local/socket-server.js";
import { workspaceHandlers } from "../src/core/workspace.js";
import type { WorkspacePort, WorktreeSpec } from "../src/platform/types.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const run of cleanups.splice(0).reverse()) run();
});
const temp = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "core-workspace-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

function repository(root: string) {
  const checkout = join(root, "repo");
  mkdirSync(checkout);
  git(checkout, "init", "-q", "-b", "main");
  git(
    checkout,
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@example.test",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "main"
  );
  writeFileSync(join(checkout, ".local"), "secret\n");
  return checkout;
}

/** A small real port: Git worktrees beside or nested, plain copies. */
function port(calls: string[]): WorkspacePort {
  const where = (spec: WorktreeSpec) =>
    spec.nested
      ? join(spec.directory, spec.nested, spec.branch.replace(/\//g, "-"))
      : join(
          dirname(spec.directory),
          `${basename(spec.directory)}-${spec.branch.replace(/\//g, "-")}`
        );
  return {
    async resolvePath(path, options) {
      calls.push(
        `resolve ${path}` +
          (options && Object.keys(options).length
            ? ` ${JSON.stringify(options)}`
            : "")
      );
      return {
        resolvedPath: pathFromWire(path),
        canonicalPath: null,
        exists: false,
        isDirectory: false,
        isGitRepo: false,
        privacyRestricted: false,
        projectRoot: null,
        git: null,
      };
    },
    async observe(path) {
      calls.push(`observe ${path}`);
      return {
        path,
        branch: git(path, "branch", "--show-current"),
        stateId: "state",
        unmerged: false,
        changedFiles: [],
        uncommittedFiles: [],
      };
    },
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
      const path = where(spec);
      return { path, branch: spec.branch, taken: existsSync(path) };
    },
    async create(spec, path) {
      calls.push(`create ${path}`);
      if (existsSync(path)) throw new Error(`exists: ${path}`);
      git(
        spec.directory,
        "worktree",
        "add",
        "-q",
        ...(spec.create
          ? ["-b", spec.branch, path, spec.base]
          : [path, spec.base])
      );
      return { path, branch: spec.branch };
    },
    async release(_session, { path }, { deleteBranch }) {
      calls.push(`release ${path}`);
      if (!existsSync(path)) return true;
      const branch = git(path, "branch", "--show-current");
      const common = git(
        path,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir"
      );
      git(dirname(common), "worktree", "remove", "--force", path);
      if (deleteBranch) git(dirname(common), "branch", "-D", branch);
      return true;
    },
    async copyIgnored(source, destination, names) {
      calls.push(`copy ${names.join(",")}`);
      const copied = names.filter((name) => existsSync(join(source, name)));
      for (const name of copied)
        copyFileSync(join(source, name), join(destination, name));
      return copied;
    },
    async installDependencies(_directory, report) {
      calls.push("install");
      await report({ status: "done", detail: "nothing to install" });
    },
    async locate(path) {
      if (!existsSync(path)) return "missing";
      if (!statSync(path).isDirectory()) return "not_directory";
      return { directory: realpathSync(path) };
    },
    async git(directory) {
      if (basename(directory) === "unreadable") return "error";
      let top: string;
      try {
        top = git(directory, "rev-parse", "--show-toplevel");
      } catch {
        return null;
      }
      const common = git(
        directory,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir"
      );
      return {
        repoRoot: dirname(common),
        branch: git(directory, "branch", "--show-current"),
        worktreePath: top,
        worktreeName: basename(top),
        isWorktree: true,
      };
    },
  };
}

async function harness(fileBytes?: WorkspacePort["fileBytes"]) {
  const root = temp();
  const state = join(root, "state");
  mkdirSync(state);
  const store = new BindingStore(state);
  const calls: string[] = [];
  const fence = new WriteFence(false);
  const socket = join(root, "r.sock");
  const nonce = randomBytes(8).toString("hex");
  const server = await serveSocket(
    socket,
    nonce,
    {
      calls: workspaceHandlers(state, store, {
        ...port(calls),
        ...(fileBytes && { fileBytes }),
      }),
    },
    fence
  );
  const connection = await LocalSocketConnection.connect({ socket, nonce });
  cleanups.push(() => {
    connection.close();
    server.close();
  });
  return { root, state, store, calls, fence, connection };
}

const request = (
  session: string,
  directory: string,
  worktree?: Req<"workspace.prepare">["worktree"]
): Req<"workspace.prepare"> => ({
  session: sessionFromWire(session),
  source: { directory: pathFromWire(directory) },
  ...(worktree && { worktree }),
  copyIgnored: [".local"],
  installDependencies: true,
});

describe("workspace.release", () => {
  const release = (session: string) => ({
    session: sessionFromWire(session),
    deleteBranch: true,
    originalBranch: "feature",
  });

  it.each([false, true])(
    "forgets the owned binding and receipt (already gone: %s)",
    async (gone) => {
      const { root, state, connection, calls, store } = await harness();
      const repo = repository(root);
      const prepared = await connection.call(
        "workspace.prepare",
        request("owner", repo, {
          name: "feature",
          branch: "feature",
          base: "main",
          create: true,
        })
      );
      const tree = String(prepared.worktree!.path);
      if (gone) rmSync(tree, { recursive: true });
      else writeFileSync(join(tree, "late"), "written after prepare");
      expect(
        await connection.call("workspace.release", release("owner"))
      ).toEqual({ removed: true });
      expect(calls.filter((call) => call.startsWith("release "))).toEqual([
        `release ${tree}`,
      ]);
      expect(existsSync(tree)).toBe(false);
      expect(git(repo, "branch", "--list", "feature")).toBe(
        gone ? "+ feature" : ""
      );
      expect(await store.get("owner")).toBeNull();
      expect(existsSync(join(state, "owner", "workspace-preparation"))).toBe(
        false
      );
      expect(
        await connection.call("workspace.release", release("owner"))
      ).toEqual({ removed: true });
    }
  );

  it("preserves an external directory, the primary checkout, and another session's worktree", async () => {
    const { root, connection, calls, store } = await harness();
    const repo = repository(root);
    const folder = join(root, "folder");
    mkdirSync(folder);
    const owner = await connection.call(
      "workspace.prepare",
      request("owner", repo, {
        name: "feature",
        branch: "feature",
        base: "main",
        create: true,
      })
    );
    const tree = String(owner.worktree!.path);
    await store.import([
      {
        session: "primary",
        path: repo,
        currentPath: null,
        worktree: { path: repo, branch: "main", base: "main" },
      },
    ]);
    await connection.call("workspace.prepare", request("folder", folder));
    await connection.call("workspace.prepare", request("borrower", tree));
    for (const session of ["primary", "folder", "borrower"]) {
      expect(
        await connection.call("workspace.release", release(session))
      ).toEqual({ removed: false });
    }
    expect(calls.filter((call) => call.startsWith("release "))).toEqual([]);
    expect([repo, folder, tree].every(existsSync)).toBe(true);
  });
});

describe("workspace.prepare from a directory", () => {
  it("binds a folder as external and reports ready", async () => {
    const { root, connection, store } = await harness();
    const folder = join(root, "folder");
    mkdirSync(folder);
    const events: unknown[] = [];
    const binding = await connection.call(
      "workspace.prepare",
      request("f", folder),
      {
        onEvent: (event) => events.push(event),
      }
    );
    expect(binding).toMatchObject({
      path: folder,
      worktree: null,
      moved: false,
    });
    expect(events).toEqual([{ phase: "ready" }]);
    expect(await store.get("f")).toMatchObject({
      path: folder,
      checkout: { path: folder, ownership: "external" },
      source: "prepare",
    });
  });

  it("makes, prepares and binds a worktree, with events in order before the answer", async () => {
    const { root, connection, store, calls, state } = await harness();
    const checkout = repository(root);
    const events: unknown[] = [];
    const binding = await connection.call(
      "workspace.prepare",
      request("w", checkout, {
        name: "W",
        branch: "feature/w",
        create: true,
        location: { nested: "nest/here" },
      }),
      { onEvent: (event) => events.push(event) }
    );
    const made = join(checkout, "nest", "here", "feature-w");
    expect(binding).toMatchObject({
      path: made,
      worktree: { path: made, branch: "feature/w", base: "main" },
      git: { branch: "feature/w" },
    });
    expect(events).toEqual([
      { phase: "workspace" },
      { phase: "copy" },
      { phase: "dependencies" },
      { phase: "dependencies", status: "done", detail: "nothing to install" },
      { phase: "ready" },
    ]);
    // Main's rule: the base defaults to main.
    expect(calls[0]).toBe("plan feature/w main true");
    expect(readFileSync(join(made, ".local"), "utf8")).toBe("secret\n");
    expect(await store.get("w")).toMatchObject({
      checkout: {
        path: made,
        ownership: "owned",
        branch: "feature/w",
        base: "main",
      },
    });
    const receipt = JSON.parse(
      readFileSync(join(state, "w", "workspace-preparation"), "utf8")
    );
    expect(receipt).toMatchObject({
      copy: [".local"],
      install: true,
      worktree: { path: made, complete: true },
    });
    expect(receipt).not.toHaveProperty("pending");

    // A repeat answers from the record; a different request is a conflict.
    calls.length = 0;
    await connection.call(
      "workspace.prepare",
      request("w", checkout, {
        name: "W",
        branch: "feature/w",
        create: true,
        location: { nested: "nest/here" },
      })
    );
    expect(calls).toEqual([]);
    await expect(
      connection.call(
        "workspace.prepare",
        request("w", checkout, { name: "W", branch: "other", create: true })
      )
    ).rejects.toMatchObject({
      code: "conflict",
      details: { status: 409 },
      message: "This launch already owns a different worktree.",
    });
  });

  it("checks out the base itself when not creating a branch", async () => {
    const { root, connection, calls } = await harness();
    const checkout = repository(root);
    git(checkout, "branch", "topic");
    const binding = await connection.call(
      "workspace.prepare",
      request("t", checkout, {
        name: "T",
        branch: "",
        base: "topic",
        create: false,
      })
    );
    expect(calls[0]).toBe("plan topic topic false");
    expect(binding.worktree).toMatchObject({ branch: "topic", base: "topic" });
  });

  it("never records a path that was already there as its own", async () => {
    const { root, connection, state } = await harness();
    const checkout = repository(root);
    mkdirSync(join(root, "repo-taken"));
    await expect(
      connection.call(
        "workspace.prepare",
        request("x", checkout, { name: "X", branch: "taken", create: true })
      )
    ).rejects.toMatchObject({ message: expect.stringContaining("exists") });
    const receipt = JSON.parse(
      readFileSync(join(state, "x", "workspace-preparation"), "utf8")
    );
    expect(receipt).not.toHaveProperty("pending");
    expect(receipt).not.toHaveProperty("worktree");
  });

  it("replaces a binding the import wrote for the session, never a prepared one", async () => {
    const { root, connection, store } = await harness();
    const checkout = repository(root);
    await store.import([
      { session: "r", path: checkout, currentPath: null, worktree: null },
    ]);
    await connection.call(
      "workspace.prepare",
      request("r", checkout, { name: "R", branch: "r", create: true })
    );
    expect(await store.get("r")).toMatchObject({
      checkout: { ownership: "owned", branch: "r" },
      source: "prepare",
    });
    expect(
      await store.import([
        { session: "r", path: checkout, currentPath: null, worktree: null },
      ])
    ).toMatchObject({ kept: 1, added: 0 });
  });

  it("refuses bad input and other sources", async () => {
    const { root, connection } = await harness();
    const checkout = repository(root);
    for (const nested of ["", "../out", "/abs", "a/../../b"])
      await expect(
        connection.call(
          "workspace.prepare",
          request("n", checkout, {
            name: "N",
            branch: "n",
            create: true,
            location: { nested },
          })
        )
      ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      connection.call("workspace.prepare", {
        ...request("c", checkout),
        copyIgnored: ["a/b"],
      })
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      connection.call("workspace.prepare", {
        ...request("s", checkout),
        source: { scratch: true },
      })
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      connection.call("workspace.prepare", request("..", checkout))
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("is refused while frozen, and resume answers null without a receipt", async () => {
    const { root, connection, fence } = await harness();
    const checkout = repository(root);
    expect(
      await connection.call("workspace.resume", {
        session: sessionFromWire("none"),
      })
    ).toBeNull();
    await fence.freeze();
    cleanups.push(() => fence.thaw());
    await expect(
      connection.call("workspace.prepare", request("z", checkout))
    ).rejects.toMatchObject({ code: "fenced" });
    await expect(
      connection.call("workspace.resume", { session: sessionFromWire("z") })
    ).rejects.toMatchObject({ code: "fenced" });
  });
});

describe("workspace.prepare from another session", () => {
  it("uses the parent's current folder, retaining both bindings on retry", async () => {
    const { root, connection, store } = await harness();
    const checkout = repository(root);
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    const current = repository(elsewhere);
    await connection.call("workspace.prepare", request("parent", checkout));
    await store.select("parent", current);
    const source = { session: sessionFromWire("parent") };
    const borrower = { ...request("borrower", checkout), source };
    const independent = {
      ...request("independent", checkout, {
        name: "independent",
        branch: "independent",
        base: "main",
        create: true,
      }),
      source,
    };
    expect(await connection.call("workspace.prepare", borrower)).toMatchObject({
      path: current,
      worktree: null,
    });
    const prepared = await connection.call("workspace.prepare", independent);
    expect(prepared.worktree).toMatchObject({ branch: "independent" });
    expect(git(current, "branch", "--list", "independent")).toBe(
      "+ independent"
    );
    expect(git(checkout, "branch", "--list", "independent")).toBe("");

    await store.select("parent", null);
    expect(await connection.call("workspace.prepare", borrower)).toMatchObject({
      path: current,
    });
    expect(await connection.call("workspace.prepare", independent)).toEqual(
      prepared
    );
  });
});

describe("workspace.select", () => {
  const select = (session: string, path: string | null) => ({
    session: sessionFromWire(session),
    path: path === null ? null : pathFromWire(path),
  });

  it("records the folder a session moved into, never as its own, and moves back", async () => {
    const { root, connection, store } = await harness();
    const checkout = repository(root);
    await connection.call(
      "workspace.prepare",
      request("s", checkout, { name: "S", branch: "agent/s", create: true })
    );
    const launched = await store.get("s");
    const otherParent = join(root, "other-parent");
    mkdirSync(otherParent);
    const other = repository(otherParent);
    const sub = join(other, "src");
    mkdirSync(sub);

    // A subdirectory moves the session to its checkout's root.
    const moved = await connection.call("workspace.select", select("s", sub));
    expect(moved).toMatchObject({
      path: other,
      moved: true,
      repositoryRoot: other,
      checkoutRoot: launched!.checkout.path,
      git: { worktreePath: other, branch: "main" },
    });
    expect(await store.get("s")).toEqual({ ...launched, currentPath: other });

    // The launch checkout itself is no move.
    const home = await connection.call(
      "workspace.select",
      select("s", launched!.checkout.path)
    );
    expect(home).toMatchObject({ moved: false, path: launched!.checkout.path });
    expect(await store.get("s")).toEqual(launched);

    await connection.call("workspace.select", select("s", other));
    const back = await connection.call("workspace.select", select("s", null));
    expect(back).toMatchObject({ moved: false, path: launched!.checkout.path });
    expect(await store.get("s")).toEqual(launched);
  });

  it("accepts a folder outside Git and refuses what main refuses", async () => {
    const { root, connection, store } = await harness();
    const folder = join(root, "folder");
    mkdirSync(folder);
    await connection.call("workspace.prepare", request("p", folder));
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(
      await connection.call("workspace.select", select("p", plain))
    ).toMatchObject({
      path: plain,
      moved: true,
      repositoryRoot: null,
      git: null,
    });

    const file = join(root, "file.txt");
    writeFileSync(file, "x");
    const unreadable = join(root, "unreadable");
    mkdirSync(unreadable);
    for (const [path, message] of [
      [join(root, "nope"), `${join(root, "nope")} does not exist.`],
      [file, `${file} is not a directory.`],
      [unreadable, `Could not read git state in ${unreadable}.`],
      ["relative/dir", "Workspace path must be absolute."],
    ])
      await expect(
        connection.call("workspace.select", select("p", path))
      ).rejects.toMatchObject({
        code: "invalid",
        details: { status: 400 },
        message,
      });
    // A refusal records nothing.
    expect((await store.get("p"))?.currentPath).toBe(plain);
    await expect(
      connection.call("workspace.select", select("unknown", plain))
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("is refused while frozen, writing nothing", async () => {
    const { root, connection, store, fence } = await harness();
    const folder = join(root, "folder");
    mkdirSync(folder);
    await connection.call("workspace.prepare", request("f", folder));
    await fence.freeze();
    await expect(
      connection.call("workspace.select", select("f", root))
    ).rejects.toMatchObject({ code: "fenced" });
    expect((await store.get("f"))?.currentPath).toBeNull();
  });
});

describe("workspace.observe", () => {
  const observe = (session: string) => ({ session: sessionFromWire(session) });

  it("answers what the binding may remove, observing only an owned checkout", async () => {
    const { root, connection, calls, store } = await harness();
    const repo = repository(root);
    const folder = join(root, "folder");
    mkdirSync(folder);
    const owner = await connection.call(
      "workspace.prepare",
      request("owner", repo, {
        name: "feature",
        branch: "feature",
        base: "main",
        create: true,
      })
    );
    const tree = String(owner.worktree!.path);
    await connection.call("workspace.prepare", request("folder", folder));
    await connection.call("workspace.prepare", {
      ...request("borrower", folder),
      source: { session: sessionFromWire("owner") },
    });
    calls.length = 0;
    expect(
      await connection.call("workspace.observe", observe("owner"))
    ).toEqual({
      ownership: "owned",
      owner: "owner",
      borrowers: [],
      checkout: {
        path: tree,
        branch: "feature",
        stateId: "state",
        unmerged: false,
        changedFiles: [],
        uncommittedFiles: [],
      },
    });
    expect(
      await connection.call("workspace.observe", observe("folder"))
    ).toEqual({
      ownership: "external",
      owner: null,
      borrowers: [],
      checkout: null,
    });
    expect(
      await connection.call("workspace.observe", observe("borrower"))
    ).toEqual({
      ownership: "borrowed",
      owner: "owner",
      borrowers: [],
      checkout: null,
    });
    expect(calls).toEqual([`observe ${tree}`]);
    // Gone: still the session's own, with nothing to observe.
    rmSync(tree, { recursive: true });
    await store.forget("owner");
    await store.import([
      {
        session: "owner",
        path: tree,
        currentPath: null,
        worktree: { path: tree, branch: "feature", base: "main" },
      },
    ]);
    expect(
      await connection.call("workspace.observe", observe("owner"))
    ).toEqual({
      ownership: "owned",
      owner: "owner",
      borrowers: [],
      checkout: null,
    });
    await expect(
      connection.call("workspace.observe", observe("nobody"))
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("workspace.observe with policy ownership", () => {
  it("answers ownership and reads no checkout state; without it, the state is read", async () => {
    const { root, connection, calls } = await harness();
    const repo = repository(root);
    const owner = await connection.call(
      "workspace.prepare",
      request("owner", repo, {
        name: "feature",
        branch: "feature",
        base: "main",
        create: true,
      })
    );
    const tree = String(owner.worktree!.path);
    calls.length = 0;
    expect(
      await connection.call("workspace.observe", {
        session: sessionFromWire("owner"),
        policy: "ownership",
      })
    ).toEqual({
      ownership: "owned",
      owner: "owner",
      borrowers: [],
      checkout: null,
    });
    expect(calls).toEqual([]);
    const state = await connection.call("workspace.observe", {
      session: sessionFromWire("owner"),
    });
    expect(state.checkout).toMatchObject({ path: tree, stateId: "state" });
    expect(calls).toEqual([`observe ${tree}`]);
  });
});

describe("path.resolve", () => {
  it("answers from the platform's port, as the workload", async () => {
    const { connection, calls } = await harness();
    expect(
      await connection.call("path.resolve", { path: "~/somewhere" })
    ).toMatchObject({ resolvedPath: "~/somewhere", exists: false });
    expect(calls).toEqual(["resolve ~/somewhere"]);
  });

  it("passes the matching options to the port", async () => {
    const { connection, calls } = await harness();
    await connection.call("path.resolve", {
      path: "/launch",
      projectRoot: true,
      canonical: ["/a", "/b"],
      git: false,
    });
    expect(calls).toEqual([
      'resolve /launch {"projectRoot":true,"canonical":["/a","/b"],"git":false}',
    ]);
  });
});

describe("inline session files", () => {
  async function files() {
    const { mkdir } = await import("node:fs/promises");
    const { deliverSessionFile, readSessionFileBytes } =
      await import("../src/workload/files/session-bytes.js");
    const fixture = await harness({
      async put(directory, name, data) {
        await mkdir(directory, { recursive: true });
        await deliverSessionFile(directory, name, data);
        return join(directory, name);
      },
      get: readSessionFileBytes,
    });
    const repo = repository(fixture.root);
    await fixture.store.import([
      { session: "files", path: repo, currentPath: null, worktree: null },
    ]);
    return { ...fixture, repo };
  }
  const input = (text: string) => ({
    session: sessionFromWire("files"),
    name: "résumé (1).txt",
    size: Buffer.byteLength(text),
    digest: createHash("sha256").update(text).digest("hex"),
    blob: Buffer.from(text).toString("base64"),
  });

  it("round trips inline bytes and preserves the previous file on invalid metadata", async () => {
    const { connection, repo } = await files();
    const request = input("hello ✓");
    const { path } = await connection.call("files.put", request);
    expect(readFileSync(String(path), "utf8")).toBe("hello ✓");
    const result = await connection.call("files.get", {
      session: request.session,
      path: String(path),
    });
    expect(result).toEqual({
      name: request.name,
      size: request.size,
      digest: request.digest,
      blob: request.blob,
    });
    for (const invalid of [
      { ...input("other"), size: 0 },
      { ...input("other"), digest: request.digest },
      { ...request, name: "../escape" },
    ])
      await expect(connection.call("files.put", invalid)).rejects.toMatchObject(
        { code: "invalid" }
      );
    expect(readFileSync(String(path), "utf8")).toBe("hello ✓");
    expect(existsSync(join(repo, "escape"))).toBe(false);
    writeFileSync(join(repo, "relative.txt"), "selected checkout");
    expect(
      (
        await connection.call("files.get", {
          session: request.session,
          path: "relative.txt",
        })
      ).blob
    ).toBe(Buffer.from("selected checkout").toString("base64"));
  });

  it("rejects unbound sessions and nonregular download sources", async () => {
    const { connection, repo } = await files();
    await expect(
      connection.call("files.put", {
        ...input("secret"),
        session: sessionFromWire("missing"),
      })
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      connection.call("files.get", {
        session: sessionFromWire("missing"),
        path: repo,
      })
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      connection.call("files.get", {
        session: sessionFromWire("files"),
        path: repo,
      })
    ).rejects.toThrow("Not a regular file");
  });
});

it("preserves borrowed Local bindings across restart imports and an ordered parent/child release", async () => {
  const { root, state, store, connection, calls } = await harness();
  const repo = repository(root);
  const prepared = await connection.call(
    "workspace.prepare",
    request("owner", repo, {
      name: "owned",
      branch: "owned",
      base: "main",
      create: true,
    })
  );
  const tree = String(prepared.path);
  const borrow = {
    ...request("child", tree),
    source: { session: sessionFromWire("owner") },
  };
  await connection.call("workspace.prepare", borrow);
  expect(await store.get("child")).toMatchObject({
    source: "prepare",
    borrowedFrom: "owner",
    checkout: { ownership: "external" },
  });

  // A replacement runner imports controller rows before adopting its hosts.
  const replacement = new BindingStore(state);
  const ownerIdentity = (await replacement.get("owner"))!.checkout.identity;
  await replacement.import([
    {
      session: "owner",
      path: tree,
      currentPath: null,
      worktree: { path: tree, branch: "owned", base: "main" },
    },
    { session: "child", path: tree, currentPath: null, worktree: null },
    {
      session: "external",
      path: repo,
      currentPath: null,
      worktree: { path: repo, branch: "main", base: "main" },
    },
  ]);
  const handlers = workspaceHandlers(state, replacement, port(calls));
  const context = { receiveBlob: async () => {}, emit() {} };
  expect(await handlers["workspace.prepare"]!(borrow, context)).toMatchObject({
    path: tree,
    worktree: null,
  });
  expect((await replacement.get("owner"))!.checkout.identity).toBe(
    ownerIdentity
  );
  expect(await replacement.get("child")).toMatchObject({
    source: "prepare",
    borrowedFrom: "owner",
  });
  expect(
    await handlers["workspace.observe"]!(
      { session: sessionFromWire("child") },
      context
    )
  ).toMatchObject({ ownership: "borrowed", owner: "owner", checkout: null });
  expect((await replacement.get("external"))!.checkout.ownership).toBe(
    "external"
  );

  // Cascade order: a borrower never removes the parent's dirty checkout.
  writeFileSync(join(tree, "dirty"), "must survive the child");
  expect(
    await handlers["workspace.release"]!(
      {
        session: sessionFromWire("child"),
        deleteBranch: true,
        originalBranch: "owned",
      },
      context
    )
  ).toEqual({ removed: false });
  expect(readFileSync(join(tree, "dirty"), "utf8")).toBe(
    "must survive the child"
  );
  await replacement.forget("child"); // host retirement is archive's separate responsibility
  expect(
    await handlers["workspace.release"]!(
      {
        session: sessionFromWire("owner"),
        deleteBranch: true,
        originalBranch: "owned",
      },
      context
    )
  ).toEqual({ removed: true });
  expect(existsSync(tree)).toBe(false);
  expect(existsSync(repo)).toBe(true);
});
