/*
 * The supervisor and the core share current session records under bindings/.
 * The core tracks their digest in its private .bindings directory. On a
 * mismatch it reads the supervisor files again, including the owner's files
 * for a borrower. Writers commit the supervisor files first so the next read
 * can recover if a process exits before committing the core record.
 *
 * The binding contains the managed, borrower or named-folder marker. The
 * .repository file identifies the checkout or scratch session. A named
 * folder stores its directory in .cwd. The .selected-cwd, .borrowed-cwd and
 * .borrowed-from files record selection and borrowing.
 */
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import type { LauncherBinding } from "@dispatch/runner-client/launcher";
import {
  BINDINGS_DIR,
  BindingStore,
  bindingFileName,
  type BindingFiles,
  type StoredBinding,
} from "../../local/bindings.js";
import { RECEIPT_FILE, type Receipt } from "../../core/workspace.js";
import type { PrivsepFs } from "./fs.js";
import {
  PRIVATE_MODE,
  assertProtected,
  isPrivate,
  ownedDirectory,
  storageKey,
  storageKeyPattern,
  type Ids,
  type Layout,
} from "./layout.js";
import type { WorkloadCommand } from "./location.js";

export const MANAGED_BINDING = "\0managed";
/**
 * A folder an agent named (D7), bound with no worktree: its `.cwd` holds the
 * path the workload resolved. External: the runner never removes it.
 */
export const FOLDER_BINDING = "\0folder";
/** Today's files a session's binding is read from. */
const LEGACY = [
  "",
  ".repository",
  ".cwd",
  ".selected-cwd",
  ".borrowed-cwd",
  ".borrowed-from",
] as const;

const forbidden = () =>
  new RunnerCallError({
    code: "forbidden",
    message: "The runner binding store is not the supervisor's own.",
  });

/**
 * The store's records in `bindings/.bindings`, as the supervisor. Every
 * call first checks the way there: `<state>` protected, `bindings` and the
 * store private to the supervisor, neither a link. One supervisor holds the
 * state lock and the core prepares one session at a time, so `create` may
 * look before it writes.
 */
export function privsepFiles(
  fs: PrivsepFs,
  ids: Ids,
  paths: Layout
): BindingFiles & { dir: string } {
  const dir = join(paths.bindings, BINDINGS_DIR);
  async function guard() {
    await assertProtected(fs, ids, paths.state, paths.state);
    for (const path of [paths.bindings, dir])
      if (
        !isPrivate(await fs.lstat(path), ids) ||
        (await fs.realpath(path).catch(() => null)) !== path
      )
        throw forbidden();
  }
  const read = async (name: string) => {
    await guard();
    return fs.read(join(dir, name));
  };
  return {
    dir,
    async prepare() {
      await ownedDirectory(fs, ids, dir, PRIVATE_MODE);
      await guard();
    },
    read,
    exists: async (name) => (await read(name)) !== null,
    async create(name, text) {
      if ((await read(name)) !== null) return false;
      await fs.writePrivate(dir, name, text);
      return true;
    },
    async replace(name, text) {
      await guard();
      await fs.writePrivate(dir, name, text);
    },
    async remove(name) {
      await guard();
      await fs.rm(join(dir, name));
    },
  };
}

type LegacyFiles = Record<string, string | null>;

const withoutDigest = ({
  legacy: _legacy,
  ...binding
}: StoredBinding): StoredBinding => binding;

export class PrivsepBindings extends BindingStore {
  constructor(
    private readonly fs: PrivsepFs,
    private readonly paths: Layout,
    private readonly asWorkload: WorkloadCommand,
    files: BindingFiles
  ) {
    super(paths.bindings, files);
  }

  private file(key: string, suffix = "") {
    return join(this.paths.bindings, key + suffix);
  }

  private async receipt(session: string): Promise<Receipt | null> {
    const raw = await this.fs.read(
      join(this.paths.receipts, storageKey(session), RECEIPT_FILE)
    );
    return raw === null ? null : (JSON.parse(raw) as Receipt);
  }

  /**
   * Today's files for a key as they are now, and for a borrower the
   * owner's binding and repository its checkout is read from.
   */
  private async legacyFiles(key: string): Promise<LegacyFiles> {
    const files: LegacyFiles = {};
    for (const suffix of LEGACY)
      files[key + suffix] = await this.fs.read(this.file(key, suffix));
    const owner = this.ownerOf(files[key]!);
    if (owner && owner !== key)
      for (const suffix of ["", ".repository"])
        files[owner + suffix] = await this.fs.read(this.file(owner, suffix));
    return files;
  }

  private ownerOf(binding: string | null): string | null {
    if (binding === MANAGED_BINDING) return null;
    if (!binding?.startsWith(MANAGED_BINDING + ":")) return null;
    const owner = binding.slice(MANAGED_BINDING.length + 1);
    return storageKeyPattern.test(owner) ? owner : null;
  }

  private static digest(files: LegacyFiles): string {
    return createHash("sha256")
      .update(JSON.stringify(Object.entries(files).sort()))
      .digest("base64url");
  }

  /** The managed checkout a key owns: the session itself for scratch. */
  private managedLaunch(key: string, files: LegacyFiles): string | null {
    const repository = files[key + ".repository"];
    if (repository === null || repository === undefined) return null;
    const session = join(this.paths.sessions, key);
    return JSON.parse(repository) === null
      ? session
      : join(session, "checkout");
  }

  /** The binding today's files describe, as an older build reads them. */
  private async fromLegacy(
    session: string,
    key: string,
    files: LegacyFiles
  ): Promise<StoredBinding | null> {
    const optional = (suffix: string) => {
      const value = files[key + suffix];
      return value === "" || value === undefined ? null : value;
    };
    const binding = files[key];
    if (binding === null || binding === undefined) return null;
    let launch: string | null;
    let ownership: StoredBinding["checkout"]["ownership"] = "external";
    if (binding === MANAGED_BINDING) {
      launch = this.managedLaunch(key, files);
      ownership = "owned";
    } else if (binding.startsWith(MANAGED_BINDING + ":")) {
      const owner = this.ownerOf(binding);
      if (!owner) return null;
      launch = this.managedLaunch(owner, files);
    } else if (binding === FOLDER_BINDING) launch = optional(".cwd");
    else return null;
    if (launch === null) return null;
    const borrowed = optional(".borrowed-cwd");
    const borrowedFrom = borrowed && optional(".borrowed-from");
    const worktree = (await this.receipt(session))?.worktree;
    return {
      version: 1,
      session,
      path: borrowed ?? launch,
      currentPath: optional(".selected-cwd"),
      checkout: {
        path: launch,
        ownership,
        branch: worktree?.path === launch ? worktree.branch : null,
        base: worktree?.path === launch ? worktree.base : null,
      },
      source: "prepare",
      ...(borrowedFrom && { borrowedFrom }),
    };
  }

  /** The platform's place for a managed session's checkout. */
  checkoutOf(session: string): string {
    return join(this.paths.sessions, storageKey(session), "checkout");
  }

  /**
   * The session's record, unless today's files changed since the store
   * last saw them: then the files win, and the record follows them.
   */
  override async get(session: string): Promise<StoredBinding | null> {
    const key = storageKey(session);
    const files = await this.legacyFiles(key);
    const digest = PrivsepBindings.digest(files);
    const held = await super.get(session);
    if (held && held.legacy === digest) return withoutDigest(held);
    const current = await this.fromLegacy(session, key, files);
    if (!current) {
      if (held) await this.files.remove(bindingFileName(session));
      return null;
    }
    await this.put({ ...current, legacy: digest });
    return current;
  }

  /** The checkout's `origin` URL, read as the workload. */
  protected override readOrigin(path: string): Promise<string | null> {
    return this.asWorkload(
      "git",
      ["-C", path, "config", "--get", "remote.origin.url"],
      { git: true }
    ).then(
      (out) => out.split("\n")[0] || null,
      () => null
    );
  }

  /** Today's files, then the record (by reading them back). */
  private async bound(session: string): Promise<StoredBinding> {
    const bound = await this.get(session);
    if (!bound) throw new Error("The runner session binding is unavailable.");
    return bound;
  }

  /**
   * Bind a session the core prepared at the platform's place, in the files
   * an older build reads: the checkout's repository first, the binding
   * last, then the record. A bound session keeps its binding.
   */
  override async bindPrepared(input: LauncherBinding): Promise<StoredBinding> {
    const held = await this.get(input.session);
    if (held) return held;
    const key = storageKey(input.session);
    if (!input.worktree) return this.bindFolder(input.session, input.path);
    const checkout = this.checkoutOf(input.session);
    const receipt = await this.receipt(input.session);
    const recorded = receipt?.repository;
    if (
      input.worktree?.path !== checkout ||
      input.path !== checkout ||
      receipt?.worktree?.complete !== true
    )
      throw new RunnerCallError({
        code: "unsupported",
        message: "The prepared checkout does not match the runner workspace",
      });
    await this.fs.writePrivate(
      this.paths.bindings,
      `${key}.repository`,
      JSON.stringify(
        recorded ? { url: recorded.url, checkout: recorded.checkout } : {}
      )
    );
    await this.fs.writePrivate(this.paths.bindings, key, MANAGED_BINDING);
    return this.bound(input.session);
  }

  /**
   * A named folder: resolved as the workload, the only account that touches
   * it, and recorded where that account found it. External: nobody owns it.
   */
  private async bindFolder(
    session: string,
    path: string
  ): Promise<StoredBinding> {
    const key = storageKey(session);
    const resolved = await this.asWorkload("realpath", ["-e", "--", path]).then(
      (out) => out.replace(/\n$/, ""),
      () => null
    );
    if (!resolved || !isAbsolute(resolved))
      throw new RunnerCallError({
        code: "not_found",
        message: "Working directory does not exist or is not a directory.",
      });
    await this.fs.writePrivate(this.paths.bindings, `${key}.cwd`, resolved);
    await this.fs.writePrivate(this.paths.bindings, key, FOLDER_BINDING);
    return this.bound(session);
  }

  override async borrow(
    session: string,
    parent: string,
    path: string
  ): Promise<StoredBinding> {
    const key = storageKey(session);
    const parentKey = storageKey(parent);
    const binding = await this.fs.read(this.file(parentKey));
    // A folder session's folder is nobody's checkout: the child binds the
    // same folder as its own, with no owner and no removal rights.
    if (binding === FOLDER_BINDING && parentKey !== key)
      return this.bindFolder(session, path);
    const prefix = MANAGED_BINDING + ":";
    const owner =
      binding === MANAGED_BINDING ? parentKey : this.ownerOf(binding);
    if (
      !owner ||
      owner === key ||
      !this.managedLaunch(owner, {
        [owner + ".repository"]: await this.fs.read(
          this.file(owner, ".repository")
        ),
      })
    )
      throw new RunnerCallError({
        code: "not_found",
        message: "The author does not own a checkout on this runner.",
      });
    await this.fs.writePrivate(
      this.paths.bindings,
      `${key}.borrowed-cwd`,
      path
    );
    await this.fs.writePrivate(
      this.paths.bindings,
      `${key}.borrowed-from`,
      parent
    );
    await this.fs.writePrivate(this.paths.bindings, key, prefix + owner);
    return this.bound(session);
  }

  /** Today's files, then the record. */
  override async forget(session: string): Promise<void> {
    const key = storageKey(session);
    for (const suffix of [
      ".repository",
      ".checkout-plan",
      ".dependencies",
      ".cwd",
      ".selected-cwd",
      ".borrowed-cwd",
      ".borrowed-from",
      ".launch",
      "",
    ])
      await this.fs.rm(this.file(key, suffix));
    await super.forget(session);
  }

  /** Record the folder the session works in (null: its checkout), as today. */
  override async select(
    session: string,
    currentPath: string | null
  ): Promise<StoredBinding | null> {
    const held = await this.get(session);
    if (!held) return null;
    await this.fs.writePrivate(
      this.paths.bindings,
      `${storageKey(session)}.selected-cwd`,
      currentPath ?? ""
    );
    return this.bound(session);
  }
}
