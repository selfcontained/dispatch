/*
 * The `linux-privsep` platform's rules, proved with a fake filesystem that
 * keeps owners and modes (these tests cannot be root): where a session's
 * checkout goes, the invariant that refuses a workload-writable ancestor or
 * a link swapped in, the removal order and who runs each step, and the
 * binding adapter over the supervisor's existing files.
 */
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Entry, PrivsepFs } from "../src/platform/linux-privsep/fs.js";
import {
  assertProtected,
  checkoutParentIsProtected,
  storageKey,
  type Ids,
} from "../src/platform/linux-privsep/layout.js";
import { createLinuxPrivsep } from "../src/platform/linux-privsep/index.js";
import { MANAGED_BINDING } from "../src/platform/linux-privsep/bindings.js";
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
    // configured workspace, exactly as the supervisor writes them today.
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
    expect(await store.get("agt_configured")).toMatchObject({
      path: "/srv/project",
      checkout: { path: "/srv/project", ownership: "external" },
    });
    expect(await store.get("agt_none")).toBeNull();

    // An older build's sessions finish on its own path.
    write("agt_planned.checkout-plan", "{}");
    expect(await store.legacy("agt_owner")).toBe(true);
    expect(await store.legacy("agt_planned")).toBe(true);
    expect(await store.legacy("agt_new")).toBe(false);
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
    expect(await store.legacy("agt_new")).toBe(false);
    fs.log = [];
    const bound = await store.bindPrepared({
      session: "agt_new",
      path: where,
      currentPath: null,
      worktree: { path: where, branch: "feature", base: "main" },
    });
    expect(fs.log).toEqual([
      `write ${bindings}/agt_new.repository`,
      `write ${bindings}/agt_new`,
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
    expect(await store.legacy("agt_new")).toBe(false);

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

  it("refuses to bind anything but its own prepared checkout", async () => {
    const { bindings: store } = await platform();
    await expect(
      store.bindPrepared({
        session: "agt_dir",
        path: "/srv/project",
        currentPath: null,
        worktree: null,
      })
    ).rejects.toMatchObject({ code: "unsupported" });
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
});
