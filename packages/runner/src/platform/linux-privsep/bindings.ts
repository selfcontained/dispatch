/*
 * The core's binding store over the supervisor's existing files, until one
 * store replaces both (T23). Nothing is migrated: an older build reading
 * these files sees the same session, so a rollback during probation and
 * the agents already running keep their paths.
 *
 *   bindings/<key>                "\0managed", "\0managed:<owner>" or a
 *                                 configured workspace's name
 *   bindings/<key>.repository     the managed checkout's `{url, checkout}`,
 *                                 or `null` for a scratch session
 *   bindings/<key>.cwd            a configured workspace's directory
 *   bindings/<key>.selected-cwd   the folder the session moved into ("" none)
 *   bindings/<key>.borrowed-cwd   where a borrower started
 *   bindings/<key>.checkout-plan  an older build's unfinished preparation
 *
 * A session with a `.repository` or a plan and no core receipt was prepared
 * by an older build and finishes on that path (`legacy`).
 */
import { join } from "node:path";
import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import type { LauncherBinding } from "@dispatch/runner-client/launcher";
import type { BindingStore, StoredBinding } from "../../local/bindings.js";
import { RECEIPT_FILE, type Receipt } from "../../core/workspace.js";
import type { PrivsepFs } from "./fs.js";
import { storageKey, type Layout } from "./layout.js";
import type { WorkloadCommand } from "./location.js";

export const MANAGED_BINDING = "\0managed";
const KEY = /^(agt_[a-z0-9]+|opaque-[A-Za-z0-9_-]{43})$/;

export class PrivsepBindings implements Pick<
  BindingStore,
  "get" | "origin" | "bindPrepared" | "select" | "forget"
> {
  private readonly origins = new Map<string, Promise<string | null>>();

  constructor(
    private readonly fs: PrivsepFs,
    private readonly paths: Layout,
    private readonly asWorkload: WorkloadCommand
  ) {}

  private file(key: string, suffix = "") {
    return join(this.paths.bindings, key + suffix);
  }

  private async optional(key: string, suffix = "") {
    const value = await this.fs.read(this.file(key, suffix));
    return value === "" ? null : value;
  }

  private async receipt(session: string): Promise<Receipt | null> {
    const raw = await this.fs.read(
      join(this.paths.receipts, storageKey(session), RECEIPT_FILE)
    );
    return raw === null ? null : (JSON.parse(raw) as Receipt);
  }

  /** The managed checkout a key owns: the session itself for scratch. */
  private async managedLaunch(key: string): Promise<string | null> {
    const repository = await this.fs.read(this.file(key, ".repository"));
    if (repository === null) return null;
    const session = join(this.paths.sessions, key);
    return JSON.parse(repository) === null
      ? session
      : join(session, "checkout");
  }

  /** The platform's place for a managed session's checkout. */
  checkoutOf(session: string): string {
    return join(this.paths.sessions, storageKey(session), "checkout");
  }

  /** Whether an older build prepared this session; it finishes on that path. */
  async legacy(session: string): Promise<boolean> {
    const key = storageKey(session);
    const old =
      (await this.fs.read(this.file(key, ".repository"))) !== null ||
      (await this.fs.read(this.file(key, ".checkout-plan"))) !== null;
    return old && (await this.receipt(session)) === null;
  }

  async get(session: string): Promise<StoredBinding | null> {
    const key = storageKey(session);
    const binding = await this.fs.read(this.file(key));
    if (binding === null) return null;
    let launch: string | null;
    let ownership: StoredBinding["checkout"]["ownership"] = "external";
    if (binding === MANAGED_BINDING) {
      launch = await this.managedLaunch(key);
      ownership = "owned";
    } else if (binding.startsWith(MANAGED_BINDING + ":")) {
      const owner = binding.slice(MANAGED_BINDING.length + 1);
      if (!KEY.test(owner)) return null;
      launch = await this.managedLaunch(owner);
    } else launch = await this.optional(key, ".cwd");
    if (launch === null) return null;
    const borrowed = await this.optional(key, ".borrowed-cwd");
    const worktree = (await this.receipt(session))?.worktree;
    return {
      version: 1,
      session,
      path: borrowed ?? launch,
      currentPath: await this.optional(key, ".selected-cwd"),
      checkout: {
        path: launch,
        ownership,
        branch: worktree?.path === launch ? worktree.branch : null,
        base: worktree?.path === launch ? worktree.base : null,
      },
      source: "prepare",
    };
  }

  /** The checkout's `origin` URL, read once per path as the workload. */
  origin(path: string): Promise<string | null> {
    let origin = this.origins.get(path);
    if (!origin) {
      origin = this.asWorkload(
        "git",
        ["-C", path, "config", "--get", "remote.origin.url"],
        { git: true }
      ).then(
        (out) => out.split("\n")[0] || null,
        () => null
      );
      this.origins.set(path, origin);
    }
    return origin;
  }

  /**
   * Bind a session the core prepared at the platform's place, in the files
   * an older build reads: the checkout's repository first, the binding
   * last. A bound session keeps its binding.
   */
  async bindPrepared(input: LauncherBinding): Promise<StoredBinding> {
    const held = await this.get(input.session);
    if (held) return held;
    const key = storageKey(input.session);
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
    const bound = await this.get(input.session);
    if (!bound) throw new Error("The runner session binding is unavailable.");
    return bound;
  }

  async forget(session: string): Promise<void> {
    const key = storageKey(session);
    for (const suffix of [
      ".repository",
      ".checkout-plan",
      ".dependencies",
      ".cwd",
      ".selected-cwd",
      ".borrowed-cwd",
      ".launch",
      "",
    ])
      await this.fs.rm(this.file(key, suffix));
  }

  /** Record the folder the session works in (null: its checkout), as today. */
  async select(
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
    return { ...held, currentPath };
  }
}
