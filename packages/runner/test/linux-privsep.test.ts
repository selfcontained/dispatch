/*
 * The `linux-privsep` platform's rules, proved with a fake filesystem that
 * keeps owners and modes (these tests cannot be root): where a session's
 * checkout goes, the invariant that refuses a workload-writable ancestor or
 * a link swapped in, the removal order and who runs each step, and the
 * binding adapter over the supervisor's existing files.
 */
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  nodeFs,
  type Entry,
  type PrivsepFs,
} from "../src/platform/linux-privsep/fs.js";
import {
  assertProtected,
  checkoutParentIsProtected,
  storageKey,
  type Ids,
} from "../src/platform/linux-privsep/layout.js";
import {
  createLinuxPrivsep,
  createRemoteWorkspacePreparation,
} from "../src/platform/linux-privsep/index.js";
import {
  FOLDER_BINDING,
  MANAGED_BINDING,
} from "../src/platform/linux-privsep/bindings.js";
import type { RepositoryPort } from "../src/platform/types.js";

const ROOT = 0;
const ids: Ids = { supervisor: ROOT, uid: 1500, gid: 1500 };
const STATE = "/var/lib/dispatch-runner/state";

type Node = Entry & { content?: string; target?: string };

/** An in-memory tree with owners and modes; every mutation is logged. */
class FakeFs implements PrivsepFs {
  nodes = new Map<string, Node>();
  log: string[] = [];

  dir(path: string, uid: number, gid: number, mode: number) {
    this.nodes.set(path, { uid, gid, mode, kind: "directory" });
  }
  file(path: string, content: string) {
    this.nodes.set(path, {
      uid: ROOT,
      gid: ROOT,
      mode: 0o600,
      kind: "file",
      content,
    });
  }
  link(path: string, target: string) {
    this.nodes.set(path, {
      uid: ids.uid,
      gid: ids.gid,
      mode: 0o777,
      kind: "link",
      target,
    });
  }
  async lstat(path: string) {
    const node = this.nodes.get(path);
    if (!node) return null;
    const { uid, gid, mode, kind } = node;
    return { uid, gid, mode, kind };
  }
  async mkdir(path: string, mode: number) {
    if (this.nodes.has(path)) throw new Error(`EEXIST ${path}`);
    if (this.nodes.get(dirname(path))?.kind !== "directory")
      throw new Error(`ENOENT ${path}`);
    this.log.push(`mkdir ${path}`);
    this.dir(path, ROOT, ROOT, mode);
  }
  async lchown(path: string, uid: number, gid: number) {
    this.log.push(`chown ${path} ${uid}:${gid}`);
    const node = this.nodes.get(path)!;
    Object.assign(node, { uid, gid });
  }
  async chmod(path: string, mode: number) {
    this.log.push(`chmod ${path} ${mode.toString(8)}`);
    const node = this.nodes.get(path)!;
    if (node.kind === "link") throw new Error("chmod followed a link");
    node.mode = mode;
  }
  async realpath(path: string) {
    let resolved = "";
    for (const part of path.split("/").filter(Boolean)) {
      resolved = `${resolved}/${part}`;
      const node = this.nodes.get(resolved);
      if (!node) throw new Error(`ENOENT ${path}`);
      if (node.kind === "link") resolved = node.target!;
    }
    return resolved || "/";
  }
  async rmdir(path: string) {
    if (this.children(path).length) throw new Error(`ENOTEMPTY ${path}`);
    this.log.push(`rmdir ${path}`);
    this.nodes.delete(path);
  }
  async rm(path: string) {
    this.log.push(`rm ${path}`);
    for (const key of [...this.nodes.keys()])
      if (key === path || key.startsWith(path + "/")) this.nodes.delete(key);
  }
  async read(path: string) {
    return this.nodes.get(path)?.content ?? null;
  }
  async writePrivate(dir: string, file: string, contents: string) {
    this.log.push(`write ${join(dir, file)}`);
    this.file(join(dir, file), contents);
  }
  children(path: string) {
    return [...this.nodes.keys()].filter((key) => dirname(key) === path);
  }
}

let fs: FakeFs;
let workload: Array<{ argv: string[]; git: boolean }>;
/** Paths the workload can resolve, and where they lead. */
let workloadPaths: Map<string, string>;
const asWorkload = async (
  executable: string,
  args: string[],
  options?: { git?: boolean }
) => {
  workload.push({ argv: [executable, ...args], git: options?.git === true });
  if (executable === "/usr/bin/find") {
    // The workload empties the directory it owns.
    for (const key of [...fs.nodes.keys()])
      if (key.startsWith(args[0]! + "/")) fs.nodes.delete(key);
    return "";
  }
  if (executable === "git") return "https://example.test/o/r.git\n";
  if (executable === "realpath") {
    // The workload's own view: links it may follow, folders it may reach.
    const target = args.at(-1)!;
    const resolved = workloadPaths.get(target);
    if (!resolved) throw new Error(`realpath: ${target}: No such file`);
    return `${resolved}\n`;
  }
  throw new Error(`unexpected ${executable}`);
};

const clones: Omit<RepositoryPort, "location" | "remove"> = {
  cache: async () => ({ defaultBranch: "main" }),
  pullRequest: async () => {},
};

/** Today's layout as the supervisor leaves it at startup. */
function installed() {
  fs = new FakeFs();
  workload = [];
  workloadPaths = new Map();
  fs.dir("/", ROOT, ROOT, 0o755);
  fs.dir("/var", ROOT, ROOT, 0o755);
  fs.dir("/var/lib", ROOT, ROOT, 0o755);
  fs.dir("/var/lib/dispatch-runner", ROOT, ROOT, 0o755);
  fs.dir(STATE, ROOT, ids.gid, 0o751);
  fs.dir(`${STATE}/bindings`, ROOT, ROOT, 0o700);
  fs.dir(`${STATE}/sessions`, ROOT, ids.gid, 0o751);
  fs.dir(`${STATE}/repositories`, ROOT, ROOT, 0o711);
}

async function platform() {
  const made = await createLinuxPrivsep({
    state: STATE,
    ids,
    asWorkload,
    fs,
  });
  return { ...made, port: made.repository(clones) };
}

/** The core's record file for a session. */
const recordName = (session: string) =>
  `${createHash("sha256").update(session).digest("hex")}.json`;

const session = "agt_abc123";
const parent = `${STATE}/sessions/${session}`;
const checkout = `${parent}/checkout`;

beforeEach(installed);

describe("linux-privsep location", () => {
  it("makes today's path: a protected parent and an empty workload checkout", async () => {
    const { port, paths } = await platform();
    expect(paths.receipts).toBe(`${STATE}/bindings/workspace`);
    expect(await fs.lstat(paths.receipts)).toMatchObject({
      uid: ROOT,
      mode: 0o700,
    });
    fs.log = [];
    expect(await port.location!(session)).toBe(checkout);
    expect(await fs.lstat(parent)).toEqual({
      uid: ROOT,
      gid: ids.gid,
      mode: 0o751,
      kind: "directory",
    });
    expect(await fs.lstat(checkout)).toEqual({
      uid: ids.uid,
      gid: ids.gid,
      mode: 0o755,
      kind: "directory",
    });
    // Root makes the checkout inside a parent the workload cannot write,
    // then gives it away; nothing is made outside `sessions/<key>`.
    expect(fs.log).toEqual([
      `mkdir ${parent}`,
      `chown ${parent} 0:${ids.gid}`,
      `chmod ${parent} 751`,
      `mkdir ${checkout}`,
      `chown ${checkout} ${ids.uid}:${ids.gid}`,
      `chmod ${checkout} 755`,
    ]);
    // Again: the same path, an existing checkout left as it is.
    fs.nodes.set(`${checkout}/.git`, { ...fs.nodes.get(checkout)! });
    expect(await port.location!(session)).toBe(checkout);
    expect(fs.nodes.has(`${checkout}/.git`)).toBe(true);
  });

  it("hashes handles that are not agent ids, as the supervisor does", async () => {
    const { port } = await platform();
    const opaque = "x/../../etc";
    const key = `opaque-${createHash("sha256").update(opaque).digest("base64url")}`;
    expect(storageKey(opaque)).toBe(key);
    expect(await port.location!(opaque)).toBe(
      `${STATE}/sessions/${key}/checkout`
    );
  });

  it("repairs an older build's supervisor-owned 0711 parent", async () => {
    fs.dir(parent, ROOT, ROOT, 0o711);
    const { port } = await platform();
    expect(await port.location!(session)).toBe(checkout);
    expect(checkoutParentIsProtected(await fs.lstat(parent), ids)).toBe(true);
  });

  it("finishes a checkout interrupted between mkdir and handover", async () => {
    fs.dir(parent, ROOT, ids.gid, 0o751);
    fs.dir(checkout, ROOT, ROOT, 0o700);
    const { port } = await platform();
    expect(await port.location!(session)).toBe(checkout);
    expect(await fs.lstat(checkout)).toMatchObject({
      uid: ids.uid,
      gid: ids.gid,
      mode: 0o755,
    });
  });

  it("refuses a link swapped in for the session's parent, touching nothing", async () => {
    fs.dir("/home/w", ids.uid, ids.gid, 0o755);
    fs.link(parent, "/home/w");
    const { port } = await platform();
    fs.log = [];
    await expect(port.location!(session)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(fs.log).toEqual([]);
    expect(await fs.lstat("/home/w")).toMatchObject({ uid: ids.uid });
  });

  it("refuses a link in place of the checkout, and a checkout root did not give away", async () => {
    fs.dir(parent, ROOT, ids.gid, 0o751);
    fs.link(checkout, "/etc");
    const { port } = await platform();
    await expect(port.location!(session)).rejects.toMatchObject({
      code: "forbidden",
    });
    fs.nodes.delete(checkout);
    fs.dir(checkout, ROOT, ROOT, 0o755);
    await expect(port.location!(session)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("refuses a parent the workload owns rather than taking it over", async () => {
    fs.dir(parent, ids.uid, ids.gid, 0o700);
    const { port } = await platform();
    fs.log = [];
    await expect(port.location!(session)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(fs.log).toEqual([]);
  });

  it.each([
    ["the state directory is the workload's", STATE, ids.uid, ids.gid, 0o751],
    ["sessions is group-writable", `${STATE}/sessions`, ROOT, ids.gid, 0o771],
    ["sessions is in another group", `${STATE}/sessions`, ROOT, ROOT, 0o751],
  ])(
    "refuses when %s, before making anything",
    async (_, path, uid, gid, mode) => {
      const { port } = await platform();
      fs.dir(path, uid, gid, mode);
      fs.log = [];
      await expect(port.location!(session)).rejects.toMatchObject({
        code: "forbidden",
      });
      expect(fs.log).toEqual([]);
    }
  );

  it("checks every ancestor and that the path resolves to itself", async () => {
    fs.dir(parent, ROOT, ids.gid, 0o751);
    await expect(assertProtected(fs, ids, STATE, parent)).resolves.toBe(
      undefined
    );
    await expect(
      assertProtected(fs, ids, STATE, "/var/lib/dispatch-runner/other")
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      assertProtected(fs, ids, STATE, `${STATE}/sessions/../bindings`)
    ).rejects.toMatchObject({ code: "forbidden" });
    // A link above the state directory moves everything under it.
    fs.nodes.delete("/var/lib/dispatch-runner");
    fs.link("/var/lib/dispatch-runner", "/tmp/elsewhere");
    fs.dir("/tmp", ROOT, ROOT, 0o1777);
    fs.dir("/tmp/elsewhere", ROOT, ROOT, 0o755);
    await expect(assertProtected(fs, ids, STATE, parent)).rejects.toMatchObject(
      { code: "forbidden" }
    );
  });
});

describe("linux-privsep remove", () => {
  it("empties the checkout as the workload, then removes its protected parent", async () => {
    const { port } = await platform();
    await port.location!(session);
    fs.nodes.set(`${checkout}/file`, {
      uid: ids.uid,
      gid: ids.gid,
      mode: 0o644,
      kind: "file",
    });
    fs.log = [];
    await port.remove!(session);
    expect(workload).toEqual([
      {
        argv: ["/usr/bin/find", checkout, "-mindepth", "1", "-delete"],
        git: false,
      },
    ]);
    expect(fs.log).toEqual([`rmdir ${checkout}`, `rm ${parent}`]);
    expect(fs.nodes.has(parent)).toBe(false);
    // Nothing left: a second removal does nothing.
    await port.remove!(session);
    expect(workload).toHaveLength(1);
  });

  it("leaves a link alone instead of following it", async () => {
    fs.link(parent, "/etc");
    const { port } = await platform();
    await expect(port.remove!(session)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(workload).toEqual([]);
  });

  it("removes an older build's workload-owned scratch session as the workload", async () => {
    fs.dir(parent, ids.uid, ids.gid, 0o700);
    const { port } = await platform();
    fs.log = [];
    await port.remove!(session);
    expect(workload.map((call) => call.argv)).toEqual([
      ["/usr/bin/find", parent, "-mindepth", "1", "-delete"],
    ]);
    expect(fs.log).toEqual([`rmdir ${parent}`]);
  });
});

describe("linux-privsep bindings over the supervisor's files", () => {
  const bindings = `${STATE}/bindings`;
  const write = (name: string, content: string) =>
    fs.file(`${bindings}/${name}`, content);

  it("reads sessions an older build bound, without moving their paths", async () => {
    // A managed repository session, a scratch one, a borrower, and a
    // retired configured workspace that cannot supply a binding.
    write("agt_owner", MANAGED_BINDING);
    write(
      "agt_owner.repository",
      JSON.stringify({
        url: "https://example.test/o/r.git",
        checkout: { kind: "new", branch: "feature" },
      })
    );
    write("agt_owner.selected-cwd", "/srv/elsewhere");
    write("agt_scratch", MANAGED_BINDING);
    write("agt_scratch.repository", "null");
    write("agt_scratch.selected-cwd", "");
    write("agt_borrower", `${MANAGED_BINDING}:agt_owner`);
    write("agt_borrower.borrowed-cwd", "/srv/elsewhere");
    write("agt_configured", "ws_1");
    write("agt_configured.cwd", "/srv/project");
    const { bindings: store } = await platform();

    expect(await store.get("agt_owner")).toEqual({
      version: 1,
      session: "agt_owner",
      path: `${STATE}/sessions/agt_owner/checkout`,
      currentPath: "/srv/elsewhere",
      checkout: {
        path: `${STATE}/sessions/agt_owner/checkout`,
        ownership: "owned",
        branch: null,
        base: null,
      },
      source: "prepare",
    });
    expect(await store.get("agt_scratch")).toMatchObject({
      path: `${STATE}/sessions/agt_scratch`,
      currentPath: null,
    });
    expect(await store.get("agt_borrower")).toMatchObject({
      path: "/srv/elsewhere",
      currentPath: null,
      checkout: {
        path: `${STATE}/sessions/agt_owner/checkout`,
        ownership: "external",
      },
    });
    expect(await store.get("agt_configured")).toBeNull();
    expect(await store.get("agt_none")).toBeNull();
  });

  it("binds a prepared checkout in the files an older build reads, binding last", async () => {
    const { bindings: store, paths } = await platform();
    const where = `${STATE}/sessions/agt_new/checkout`;
    const receipt = {
      repository: {
        identity: "example.test/o/r",
        checkout: { kind: "new", branch: "feature" },
        url: "https://example.test/o/r.git",
      },
      worktree: {
        path: where,
        branch: "feature",
        base: "main",
        identity: "1:2:3",
        complete: true,
      },
    };
    fs.dir(`${paths.receipts}/agt_new`, ROOT, ROOT, 0o700);
    fs.file(
      `${paths.receipts}/agt_new/workspace-preparation`,
      JSON.stringify(receipt)
    );
    fs.log = [];
    const bound = await store.bindPrepared({
      session: "agt_new",
      path: where,
      currentPath: null,
      worktree: { path: where, branch: "feature", base: "main" },
    });
    // Today's files first, binding last; then the core's record.
    expect(fs.log).toEqual([
      `write ${bindings}/agt_new.repository`,
      `write ${bindings}/agt_new`,
      `write ${bindings}/.bindings/${recordName("agt_new")}`,
    ]);
    expect(await fs.read(`${bindings}/agt_new`)).toBe(MANAGED_BINDING);
    expect(
      JSON.parse((await fs.read(`${bindings}/agt_new.repository`))!)
    ).toEqual({
      url: "https://example.test/o/r.git",
      checkout: { kind: "new", branch: "feature" },
    });
    expect(bound).toMatchObject({
      path: where,
      checkout: {
        path: where,
        ownership: "owned",
        branch: "feature",
        base: "main",
      },
    });
    // With a receipt it is not an older build's session.

    // A bound session keeps its binding; a selection is today's file.
    fs.log = [];
    expect(
      await store.bindPrepared({
        session: "agt_new",
        path: "/elsewhere",
        currentPath: null,
        worktree: null,
      })
    ).toEqual(bound);
    expect(fs.log).toEqual([]);
    expect(await store.select("agt_new", "/srv/moved")).toMatchObject({
      currentPath: "/srv/moved",
    });
    expect(await fs.read(`${bindings}/agt_new.selected-cwd`)).toBe(
      "/srv/moved"
    );
    await store.select("agt_new", null);
    expect(await fs.read(`${bindings}/agt_new.selected-cwd`)).toBe("");
    expect(await store.select("agt_none", null)).toBeNull();
  });

  it("refuses to bind a worktree anywhere but its own place", async () => {
    const { bindings: store } = await platform();
    await expect(
      store.bindPrepared({
        session: "agt_dir",
        path: "/srv/project",
        currentPath: null,
        worktree: { path: "/srv/project", branch: "b", base: "main" },
      })
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(await fs.read(`${STATE}/bindings/agt_dir`)).toBeNull();
  });

  it("binds a folder an agent named where the workload resolves it, as external", async () => {
    const { bindings: store } = await platform();
    workloadPaths.set("/home/w/link", "/srv/project");
    const bound = await store.bindPrepared({
      session: "agt_dir",
      path: "/home/w/link",
      currentPath: null,
      worktree: null,
    });
    // Resolved by the workload, never by the supervisor.
    expect(workload.map(({ argv }) => argv)).toContainEqual([
      "realpath",
      "-e",
      "--",
      "/home/w/link",
    ]);
    expect(await fs.read(`${STATE}/bindings/agt_dir`)).toBe(FOLDER_BINDING);
    expect(await fs.read(`${STATE}/bindings/agt_dir.cwd`)).toBe("/srv/project");
    expect(bound).toMatchObject({
      path: "/srv/project",
      checkout: { path: "/srv/project", ownership: "external" },
    });
    // Nothing was made or changed in the runner's own session store.
    expect(fs.children(`${STATE}/sessions`)).toEqual([]);
  });

  it("binds a folder session's child to the same folder, owned by neither", async () => {
    const { bindings: store } = await platform();
    workloadPaths.set("/srv/project", "/srv/project");
    await store.bindPrepared({
      session: "agt_dir",
      path: "/srv/project",
      currentPath: null,
      worktree: null,
    });
    const child = await store.borrow("agt_kid", "agt_dir", "/srv/project");
    expect(child).toMatchObject({
      path: "/srv/project",
      checkout: { path: "/srv/project", ownership: "external" },
    });
    expect(child.borrowedFrom).toBeUndefined();
    expect(await fs.read(`${STATE}/bindings/agt_kid`)).toBe(FOLDER_BINDING);
    expect(await fs.read(`${STATE}/bindings/agt_kid.borrowed-from`)).toBeNull();
    // The parent's binding is as it was.
    expect(await fs.read(`${STATE}/bindings/agt_dir`)).toBe(FOLDER_BINDING);
    expect(await fs.read(`${STATE}/bindings/agt_dir.cwd`)).toBe("/srv/project");
  });

  it("answers main's error for a folder the workload cannot resolve", async () => {
    const { bindings: store } = await platform();
    await expect(
      store.bindPrepared({
        session: "agt_dir",
        path: "/root/private",
        currentPath: null,
        worktree: null,
      })
    ).rejects.toMatchObject({
      code: "not_found",
      message: "Working directory does not exist or is not a directory.",
    });
    expect(await fs.read(`${STATE}/bindings/agt_dir`)).toBeNull();
  });

  it("reads origin as the workload, once per path", async () => {
    const { bindings: store } = await platform();
    expect(await store.origin("/srv/project")).toBe(
      "https://example.test/o/r.git"
    );
    await store.origin("/srv/project");
    expect(workload).toEqual([
      {
        argv: [
          "git",
          "-C",
          "/srv/project",
          "config",
          "--get",
          "remote.origin.url",
        ],
        git: true,
      },
    ]);
  });

  it("binds the immediate parent's current folder to its existing checkout owner", async () => {
    write("agt_owner", MANAGED_BINDING);
    write("agt_owner.repository", "{}");
    write("agt_parent", `${MANAGED_BINDING}:agt_owner`);
    write("agt_parent.borrowed-cwd", "/srv/original");
    write("agt_parent.selected-cwd", "/srv/current");
    const { bindings: store } = await platform();
    const current = (await store.get("agt_parent"))!.currentPath!;
    expect(
      await store.borrow("agt_child", "agt_parent", current)
    ).toMatchObject({
      path: "/srv/current",
      borrowedFrom: "agt_parent",
      checkout: {
        path: `${STATE}/sessions/agt_owner/checkout`,
        ownership: "external",
      },
    });
    expect(await fs.read(`${bindings}/agt_child`)).toBe(
      `${MANAGED_BINDING}:agt_owner`
    );
    expect(await fs.read(`${bindings}/agt_child.repository`)).toBeNull();
  });
});

describe("linux-privsep binding records", () => {
  const bindings = `${STATE}/bindings`;
  const store = `${bindings}/.bindings`;
  const write = (name: string, content: string) =>
    fs.file(`${bindings}/${name}`, content);
  const legacy = () =>
    [...fs.nodes]
      .filter(([path]) => dirname(path) === bindings && path !== store)
      .map(([path, node]) => [path, node.content, node.mode]);

  it("keeps its records root-only inside bindings, a name no binding key takes", async () => {
    await platform();
    expect(await fs.lstat(store)).toEqual({
      uid: ROOT,
      gid: ROOT,
      mode: 0o700,
      kind: "directory",
    });
    const key = /^(agt_[a-z0-9]+|opaque-[A-Za-z0-9_-]{43})$/;
    expect(key.test(".bindings")).toBe(false);
    for (const handle of [".bindings", "bindings", "agt_x/../.bindings"])
      expect(storageKey(handle)).not.toBe(".bindings");
  });

  it("imports a session an older build bound on first read, changing none of its files", async () => {
    write("agt_owner", MANAGED_BINDING);
    write("agt_owner.repository", "{}");
    write("agt_owner.selected-cwd", "/srv/elsewhere");
    const { bindings: made } = await platform();
    const before = legacy();
    fs.log = [];
    const first = await made.get("agt_owner");
    expect(fs.log).toEqual([`write ${store}/${recordName("agt_owner")}`]);
    expect(first).toMatchObject({
      currentPath: "/srv/elsewhere",
      checkout: { ownership: "owned" },
    });
    expect(first).not.toHaveProperty("legacy");
    const record = JSON.parse(
      (await fs.read(`${store}/${recordName("agt_owner")}`))!
    );
    expect(record).toMatchObject({
      session: "agt_owner",
      currentPath: "/srv/elsewhere",
      legacy: expect.any(String),
    });
    expect(await fs.lstat(`${store}/${recordName("agt_owner")}`)).toEqual({
      uid: ROOT,
      gid: ROOT,
      mode: 0o600,
      kind: "file",
    });
    // Once: a second read is the record, and no file changes.
    fs.log = [];
    expect(await made.get("agt_owner")).toEqual(first);
    expect(fs.log).toEqual([]);
    expect(legacy()).toEqual(before);
  });

  it("a crash between today's files and the record reads as the files say", async () => {
    const { bindings: made, paths } = await platform();
    const where = `${STATE}/sessions/agt_new/checkout`;
    fs.dir(`${paths.receipts}/agt_new`, ROOT, ROOT, 0o700);
    fs.file(
      `${paths.receipts}/agt_new/workspace-preparation`,
      JSON.stringify({
        worktree: {
          path: where,
          branch: "feature",
          base: "main",
          identity: "1:2:3",
          complete: true,
        },
      })
    );
    const writePrivate = fs.writePrivate.bind(fs);
    fs.writePrivate = async (dir, file, contents) => {
      if (dir === store) throw new Error("crash");
      return writePrivate(dir, file, contents);
    };
    await expect(
      made.bindPrepared({
        session: "agt_new",
        path: where,
        currentPath: null,
        worktree: { path: where, branch: "feature", base: "main" },
      })
    ).rejects.toThrow("crash");
    fs.writePrivate = writePrivate;
    // Restarted: the files an older build reads are the session.
    const { bindings: again } = await platform();
    expect(await again.get("agt_new")).toMatchObject({
      path: where,
      checkout: { ownership: "owned", branch: "feature" },
    });
  });

  it("removes its record when the files no longer bind the session", async () => {
    write("agt_owner", MANAGED_BINDING);
    write("agt_owner.repository", "{}");
    const { bindings: made } = await platform();
    await made.get("agt_owner");
    fs.nodes.delete(`${bindings}/agt_owner`);
    expect(await made.get("agt_owner")).toBeNull();
    expect(await fs.read(`${store}/${recordName("agt_owner")}`)).toBeNull();
  });

  it("refuses a link swapped in for its records, touching nothing", async () => {
    const { bindings: made } = await platform();
    fs.nodes.delete(store);
    fs.dir("/tmp", ids.uid, ids.gid, 0o777);
    fs.link(store, "/tmp");
    write("agt_owner", MANAGED_BINDING);
    write("agt_owner.repository", "{}");
    fs.log = [];
    await expect(made.get("agt_owner")).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(fs.log).toEqual([]);
    await expect(platform()).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses a record directory the workload owns, or a bindings it can enter", async () => {
    const { bindings: made } = await platform();
    write("agt_owner", MANAGED_BINDING);
    write("agt_owner.repository", "{}");
    fs.nodes.get(store)!.uid = ids.uid;
    fs.log = [];
    await expect(made.get("agt_owner")).rejects.toMatchObject({
      code: "forbidden",
    });
    fs.nodes.get(store)!.uid = ROOT;
    fs.nodes.get(bindings)!.mode = 0o755;
    await expect(made.get("agt_owner")).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(fs.log).toEqual([]);
  });
});

/*
 * What an older build reads after this build wrote, and what this build
 * reads after an older build wrote (probation rollback, then roll forward):
 * the same session, through the core's own operations. A real directory,
 * because the core reads its receipts itself; the ids are this process's.
 */
describe("linux-privsep bindings across builds", () => {
  const owner = "agt_owner";
  const child = "agt_child";
  let state: string;
  let bindings: string;
  let ownerCheckout: string;
  let log: string[];
  const real = {
    supervisor: process.getuid!(),
    uid: process.getuid!(),
    gid: process.getgid!(),
  };
  const logged: PrivsepFs = {
    ...nodeFs,
    async rm(path) {
      log.push(`rm ${path}`);
      return nodeFs.rm(path);
    },
    async writePrivate(dir, file, contents) {
      log.push(`write ${join(dir, file)}`);
      return nodeFs.writePrivate(dir, file, contents);
    },
  };
  const legacyFiles = (key: string) =>
    [
      "",
      ".repository",
      ".cwd",
      ".selected-cwd",
      ".borrowed-cwd",
      ".borrowed-from",
    ].map((suffix) => `${bindings}/${key}${suffix}`);
  const legacyBytes = async (key: string) =>
    Object.fromEntries(
      (
        await Promise.all(
          legacyFiles(key).map(async (file) => [file, await nodeFs.read(file)])
        )
      ).filter(([, value]) => value !== null)
    );

  beforeEach(async () => {
    state = await realpath(await mkdtemp(join(tmpdir(), "privsep-builds-")));
    await chmod(state, 0o751);
    bindings = join(state, "bindings");
    await mkdir(bindings, { mode: 0o700 });
    await mkdir(join(state, "sessions"), { mode: 0o751 });
    await chmod(join(state, "sessions"), 0o751);
    await mkdir(join(state, "repositories"), { mode: 0o711 });
    ownerCheckout = join(state, "sessions", owner, "checkout");
    log = [];
    // The core prepared `owner`'s checkout: a complete receipt, no binding yet.
    const receipts = join(bindings, "workspace", owner);
    await mkdir(receipts, { recursive: true, mode: 0o700 });
    await writeFile(
      join(receipts, "workspace-preparation"),
      JSON.stringify({
        source: "/clone",
        sourceIdentity: "9:9:9",
        cwd: "/clone",
        request: { name: "feature", branch: "feature", create: false },
        repository: {
          identity: "example.test/o/r",
          checkout: { kind: "branch", branch: "feature" },
          url: "https://example.test/o/r.git",
        },
        at: ownerCheckout,
        worktree: {
          path: ownerCheckout,
          branch: "feature",
          base: "feature",
          identity: "1:2:3",
          complete: true,
        },
      })
    );
  });
  afterEach(() => rm(state, { recursive: true, force: true }));

  function preparation() {
    return createRemoteWorkspacePreparation({
      state,
      ids: real,
      asWorkload,
      fs: logged,
      async step(method, args) {
        switch (method) {
          case "workspace.identity":
            return args[0] === ownerCheckout ? "1:2:3" : null;
          case "workspace.git":
            return null;
          case "workspace.canonical":
            return args[0];
          default:
            throw new Error(`unexpected ${method}`);
        }
      },
    });
  }
  type Made = Awaited<ReturnType<typeof preparation>>;
  const resume = (made: Made, session: string) =>
    made.call("workspace.resume", { session: session as never }, () => {});
  const borrow = (made: Made) =>
    made.call(
      "workspace.prepare",
      {
        session: child as never,
        source: { session: owner as never },
        copyIgnored: [],
        installDependencies: false,
      },
      () => {}
    );
  const legacyEntries = (lines: string[]) =>
    lines.filter((line) => !line.includes("/.bindings/"));

  it("writes the files an older build reads, in today's order, bytes and modes", async () => {
    const made = await preparation();
    log = [];
    await resume(made, owner);
    expect(legacyEntries(log)).toEqual([
      `write ${bindings}/${owner}.repository`,
      `write ${bindings}/${owner}`,
    ]);
    expect(await legacyBytes(owner)).toEqual({
      [`${bindings}/${owner}`]: MANAGED_BINDING,
      [`${bindings}/${owner}.repository`]: JSON.stringify({
        url: "https://example.test/o/r.git",
        checkout: { kind: "branch", branch: "feature" },
      }),
    });
    log = [];
    await borrow(made);
    expect(legacyEntries(log)).toEqual([
      `write ${bindings}/${child}.borrowed-cwd`,
      `write ${bindings}/${child}.borrowed-from`,
      `write ${bindings}/${child}`,
    ]);
    expect(await legacyBytes(child)).toEqual({
      [`${bindings}/${child}`]: `${MANAGED_BINDING}:${owner}`,
      [`${bindings}/${child}.borrowed-cwd`]: ownerCheckout,
      [`${bindings}/${child}.borrowed-from`]: owner,
    });
    for (const key of [owner, child])
      for (const file of Object.keys(await legacyBytes(key))) {
        const entry = await nodeFs.lstat(file);
        expect(entry).toEqual({
          uid: real.supervisor,
          gid: entry!.gid,
          mode: 0o600,
          kind: "file",
        });
      }
  });

  it("keeps its records 0600 in a 0700 directory of the supervisor's", async () => {
    await resume(await preparation(), owner);
    const store = join(bindings, ".bindings");
    expect(await nodeFs.lstat(store)).toMatchObject({
      uid: real.supervisor,
      mode: 0o700,
      kind: "directory",
    });
    expect(await nodeFs.lstat(join(store, recordName(owner)))).toMatchObject({
      uid: real.supervisor,
      mode: 0o600,
      kind: "file",
    });
  });

  it("forgets exactly today's files", async () => {
    const made = await preparation();
    await resume(made, owner);
    const { bindings: store } = await createLinuxPrivsep({
      state,
      ids: real,
      asWorkload,
      fs: logged,
    });
    log = [];
    await store.forget(owner);
    expect(legacyEntries(log)).toEqual(
      [
        ".repository",
        ".checkout-plan",
        ".dependencies",
        ".cwd",
        ".selected-cwd",
        ".borrowed-cwd",
        ".borrowed-from",
        ".launch",
        "",
      ].map((suffix) => `rm ${bindings}/${owner}${suffix}`)
    );
    expect(await legacyBytes(owner)).toEqual({});
    expect(await store.get(owner)).toBeNull();
  });

  it("after an older build selects, this build borrows and resumes the selected folder", async () => {
    await resume(await preparation(), owner);
    // Rolled back: the older build moves the owner, as its select does.
    await nodeFs.writePrivate(bindings, `${owner}.selected-cwd`, "/srv/moved");
    // Rolled forward again.
    const again = await preparation();
    expect(await resume(again, owner)).toMatchObject({
      path: "/srv/moved",
      moved: true,
      checkoutRoot: ownerCheckout,
    });
    expect(await borrow(again)).toMatchObject({ path: "/srv/moved" });
    expect(await nodeFs.read(`${bindings}/${child}.borrowed-cwd`)).toBe(
      "/srv/moved"
    );
    // The older build moves it back to its checkout: this build agrees.
    await nodeFs.writePrivate(bindings, `${owner}.selected-cwd`, "");
    expect(await resume(await preparation(), owner)).toMatchObject({
      path: ownerCheckout,
      moved: false,
    });
  });

  it("after an older build discards a session, this build holds none", async () => {
    await resume(await preparation(), owner);
    // Rolled back: the older build discards the owner, removing its
    // binding files and its preparation receipt.
    for (const file of legacyFiles(owner)) await nodeFs.rm(file);
    await nodeFs.rm(join(bindings, "workspace", owner));
    const again = await preparation();
    expect(await resume(again, owner)).toBeNull();
    await expect(borrow(again)).rejects.toMatchObject({ code: "not_found" });
    expect(await legacyBytes(child)).toEqual({});
    const { bindings: store } = await createLinuxPrivsep({
      state,
      ids: real,
      asWorkload,
      fs: logged,
    });
    expect(await store.get(owner)).toBeNull();
  });
});
