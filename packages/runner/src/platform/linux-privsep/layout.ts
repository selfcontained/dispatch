/*
 * Where the `linux-privsep` runner keeps things, and the one rule that keeps
 * the supervisor (root) safe from the workload account it runs agents as:
 *
 *   A path the supervisor acts on as root (removes, chowns or chmods,
 *   writes state into, or resolves with `realpath` before handing it to a
 *   host) is reached only through directories the workload cannot write.
 *
 * Every directory from `<state>` down to `sessions/<key>` is the
 * supervisor's, in the workload's group, mode 0751: the workload can pass
 * through (and Bun can open them for reading) but never add, rename or
 * swap an entry, so a path checked once stays the same path. Bindings,
 * preparation receipts and plans are in `bindings/`, root-only 0700. Clones
 * may be the workload's: only the workload (Git) ever touches them.
 *
 * The layout is today's `/var/lib/dispatch-runner/<state>`; nothing moves.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import type { Entry, PrivsepFs } from "./fs.js";

/** Checkout ancestors: the supervisor's, workload group may traverse and list. */
export const ANCESTOR_MODE = 0o751;
/** The supervisor's own state: nobody else. */
export const PRIVATE_MODE = 0o700;

/** Who is who: the supervisor's uid and the workload's uid and gid. */
export type Ids = { supervisor: number; uid: number; gid: number };

export type Layout = {
  /** The runner state directory, canonical. */
  state: string;
  /** Root-only: binding files, plans, receipts. */
  bindings: string;
  /** Preparation receipts written by the core, inside `bindings`. */
  receipts: string;
  /** One protected parent per managed session. */
  sessions: string;
  /** Cached clones, one per repository. */
  repositories: string;
};

export function layout(state: string): Layout {
  const bindings = join(state, "bindings");
  return {
    state,
    bindings,
    receipts: join(bindings, "workspace"),
    sessions: join(state, "sessions"),
    repositories: join(state, "repositories"),
  };
}

/**
 * The file name a session's state uses: an `agt_` handle as it is, any
 * other handle hashed so it never becomes a path. The supervisor's own
 * name for the same thing, so a session keeps its files across builds.
 */
export const storageKeyPattern = /^(agt_[a-z0-9]+|opaque-[A-Za-z0-9_-]{43})$/;

export function storageKey(session: string): string {
  return /^agt_[a-z0-9]+$/.test(session)
    ? session
    : `opaque-${createHash("sha256").update(session).digest("base64url")}`;
}

const forbidden = (message: string) =>
  new RunnerCallError({ code: "forbidden", message });

/** A checkout ancestor the workload cannot write: the supervisor's, its group, 0751. */
export function checkoutParentIsProtected(
  entry: Entry | null,
  ids: Ids
): boolean {
  return (
    entry !== null &&
    entry.kind === "directory" &&
    entry.uid === ids.supervisor &&
    entry.gid === ids.gid &&
    entry.mode === ANCESTOR_MODE
  );
}

/** A directory only the supervisor can read or write. */
export function isPrivate(entry: Entry | null, ids: Ids): boolean {
  return (
    entry !== null &&
    entry.kind === "directory" &&
    entry.uid === ids.supervisor &&
    entry.mode === PRIVATE_MODE
  );
}

/**
 * Refuse unless every directory from `state` down to `target` (both
 * included) is a protected checkout ancestor and `target` resolves to
 * itself. Called before the supervisor acts on anything under `target`.
 */
export async function assertProtected(
  fs: PrivsepFs,
  ids: Ids,
  state: string,
  target: string
): Promise<void> {
  if (target !== state && !target.startsWith(state + "/"))
    throw forbidden("A runner session path is outside its state directory.");
  const parts = target
    .slice(state.length)
    .split("/")
    .filter((part) => part !== "");
  let path = state;
  for (const part of ["", ...parts]) {
    if (part === "." || part === "..")
      throw forbidden("A runner session path is not canonical.");
    if (part) path = join(path, part);
    if (!checkoutParentIsProtected(await fs.lstat(path), ids))
      throw forbidden(
        "A runner session directory is writable by the workload or not the supervisor's."
      );
  }
  if ((await fs.realpath(target).catch(() => null)) !== target)
    throw forbidden("A runner session path is not canonical.");
}

/**
 * The supervisor's own directory: made when missing, else refused unless
 * the supervisor already owns it and nobody else can write it; then its
 * group and mode are set. Today's `ownedDirectory`.
 */
export async function ownedDirectory(
  fs: PrivsepFs,
  ids: Ids,
  dir: string,
  mode: number,
  gid?: number
): Promise<void> {
  let entry = await fs.lstat(dir);
  if (!entry) {
    await fs.mkdir(dir, mode);
    entry = await fs.lstat(dir);
  }
  if (
    entry === null ||
    entry.kind !== "directory" ||
    entry.uid !== ids.supervisor ||
    entry.mode & 0o022
  )
    throw forbidden(
      "Runner state directories must be owned by the supervisor."
    );
  if (gid !== undefined && entry.gid !== gid)
    await fs.lchown(dir, ids.supervisor, gid);
  await fs.chmod(dir, mode);
}
