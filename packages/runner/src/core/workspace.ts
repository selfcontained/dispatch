/*
 * Preparing a session's checkout from a directory (`workspace.prepare`,
 * `workspace.resume`), served by the core. The core decides the steps and
 * their order, records each one, and binds the session; the platform's
 * `workspace` port does each step as the workload account.
 *
 * A launch that asks for its own worktree is recorded in a receipt under the
 * session's state directory, `<state>/<session>/workspace-preparation`,
 * before anything is made:
 *
 *   intent    the source directory, its identity, the request, and the
 *             files to copy and whether to install (so `resume` can finish)
 *   pending   the planned worktree path, written just before Git makes it
 *   worktree  what was made; `complete` once the ignored files are copied
 *             and dependencies installed
 *
 * The binding is written last, once the checkout exists. A crash at any
 * point is finished by `resume` (or a repeat of `prepare`): a pending path
 * that Git made for this branch from this repository is taken over, never
 * made a second time, and a path that was already there before is never
 * claimed. Preparation of one session runs one at a time.
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, normalize, resolve, sep } from "node:path";
import {
  pathFromWire,
  displayPath,
  RunnerCallError,
  sessionToWire,
  type Infer,
  type Req,
  type Res,
  worktreeRequest,
} from "@dispatch/runner-protocol/contract";
import type {
  CallHandlers,
  ConnectionContext,
} from "../local/socket-server.js";
import {
  git,
  isLinkedWorktreeRoot,
  type BindingStore,
  type StoredBinding,
} from "../local/bindings.js";
import type {
  CheckoutGit,
  WorkspacePort,
  WorktreeSpec,
} from "../platform/types.js";

type WorktreeRequest = Infer<typeof worktreeRequest>;
type Progress = {
  phase: "workspace" | "copy" | "dependencies" | "ready";
  status?: "done" | "failed";
  detail?: string;
};

/** What the receipt holds. Fields are those earlier builds wrote. */
export type Receipt = {
  source: string;
  sourceIdentity: string;
  cwd: string;
  request: WorktreeRequest;
  /** Ignored files to copy from the source; absent in older receipts. */
  copy?: string[];
  /** Whether dependencies are installed; absent means yes. */
  install?: boolean;
  /** The path about to be made, recorded before Git runs. */
  pending?: { path: string; branch: string };
  worktree?: {
    path: string;
    branch: string;
    base: string;
    identity: string;
    complete: boolean;
  };
};

export const RECEIPT_FILE = "workspace-preparation";

/** A preparation refusal: a conflict the caller reports as its own (status 409/400). */
const refused = (message: string, status = 409) =>
  new RunnerCallError({
    code: status === 409 ? "conflict" : "invalid",
    message,
    details: { status },
  });

function sessionDir(stateRoot: string, session: string) {
  if (
    !session ||
    session === "." ||
    session === ".." ||
    basename(session) !== session
  )
    throw new RunnerCallError({
      code: "invalid",
      message: "Invalid session state directory",
    });
  return join(stateRoot, session);
}

async function syncDirectory(dir: string) {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readReceipt(dir: string): Promise<Receipt | null> {
  try {
    return JSON.parse(await readFile(join(dir, RECEIPT_FILE), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Replace the receipt durably: written, flushed, renamed, directory synced. */
export async function writeReceipt(dir: string, receipt: Receipt) {
  const temporary = join(dir, `${RECEIPT_FILE}-${randomUUID()}`);
  try {
    await writeFile(temporary, JSON.stringify(receipt), {
      mode: 0o600,
      flag: "wx",
      flush: true,
    });
    await rename(temporary, join(dir, RECEIPT_FILE));
    await syncDirectory(dir);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Two requests ask for the same worktree, whatever their key order. */
function sameRequest(a: WorktreeRequest, b: WorktreeRequest) {
  const location = (r: WorktreeRequest) =>
    r.location === undefined || r.location === "sibling"
      ? "sibling"
      : `nested:${r.location.nested}`;
  return (
    a.name === b.name &&
    a.branch === b.branch &&
    (a.base ?? null) === (b.base ?? null) &&
    a.create === b.create &&
    location(a) === location(b)
  );
}

/** The nested directory, checked: relative, non-empty, no `..` segment. */
function nestedDir(request: WorktreeRequest): string | undefined {
  const { location } = request;
  if (location === undefined || location === "sibling") return undefined;
  const dir = location.nested;
  if (
    !dir ||
    isAbsolute(dir) ||
    normalize(dir).split(sep).includes("..") ||
    dir.split(/[\\/]/).includes("..")
  )
    throw new RunnerCallError({
      code: "invalid",
      message: "A nested worktree location must be a relative directory",
    });
  return dir;
}

/** Main's checkout rule: the base defaults to `main`; without a new branch the base is checked out. */
function spec(receipt: Receipt): WorktreeSpec {
  const { request, cwd } = receipt;
  const base = request.base ?? "main";
  return {
    directory: cwd,
    name: request.name,
    branch: request.create ? request.branch : base,
    base,
    create: request.create,
    nested: nestedDir(request),
  };
}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
function copyNames(names: readonly string[]) {
  for (const name of names)
    if (name === "." || name === ".." || !SAFE_NAME.test(name))
      throw new RunnerCallError({
        code: "invalid",
        message: `Not a top-level file name: ${JSON.stringify(name).slice(0, 200)}`,
      });
  return names;
}

/**
 * Whether `path` is the worktree a pending step asked Git for: the root of
 * a linked worktree of the source's repository with `branch` checked out.
 */
async function madeForUs(path: string, source: string, branch: string) {
  if (!(await isLinkedWorktreeRoot(path))) return false;
  const [mine, theirs, head] = await Promise.all([
    git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(path, ["symbolic-ref", "--short", "-q", "HEAD"]),
  ]);
  return (
    !!mine?.[0] &&
    !!theirs?.[0] &&
    resolve(mine[0]) === resolve(theirs[0]) &&
    head?.[0] === branch
  );
}

function wireGit(value: CheckoutGit) {
  return {
    ...value,
    repoRoot: pathFromWire(value.repoRoot),
    worktreePath: pathFromWire(value.worktreePath),
  };
}

export function workspaceHandlers(
  stateRoot: string,
  store: Pick<BindingStore, "get" | "origin" | "bindPrepared">,
  port: WorkspacePort
): CallHandlers {
  const pending = new Map<string, Promise<unknown>>();

  /** One preparation per session at a time. */
  async function serialize<T>(session: string, action: () => Promise<T>) {
    const current = (pending.get(session) ?? Promise.resolve())
      .catch(() => {})
      .then(action);
    pending.set(session, current);
    try {
      return await current;
    } finally {
      if (pending.get(session) === current) pending.delete(session);
    }
  }

  async function sourceMatches(receipt: Receipt) {
    return (
      (await port.canonical(receipt.cwd)) === receipt.source &&
      (await port.identity(receipt.source)) === receipt.sourceIdentity
    );
  }

  /** Make the worktree, or take over the one a crash left behind. */
  async function makeWorktree(
    dir: string,
    receipt: Receipt,
    emit: (p: Progress) => void
  ): Promise<NonNullable<Receipt["worktree"]>> {
    emit({ phase: "workspace" });
    if (!(await sourceMatches(receipt)))
      throw refused("The launch directory was moved or replaced.");
    const wanted = spec(receipt);
    const base = wanted.base;
    let made: { path: string; branch: string } | null = null;
    if (receipt.pending) {
      const { path, branch } = receipt.pending;
      if (await madeForUs(path, receipt.source, branch))
        made = { path, branch };
    }
    if (!made) {
      const plan = await port.plan(wanted);
      // A path that is already there is never recorded as ours: `create`
      // refuses it with main's answer.
      const record = !plan.taken;
      if (record)
        await writeReceipt(dir, {
          ...receipt,
          pending: { path: plan.path, branch: plan.branch },
        });
      try {
        made = await port.create(wanted, plan.path);
      } catch (error) {
        if (record) await writeReceipt(dir, withoutPending(receipt));
        throw error;
      }
    }
    const identity = await port.identity(made.path);
    if (!identity)
      throw refused("The prepared worktree was removed or replaced.");
    return {
      path: made.path,
      branch: made.branch,
      base,
      identity,
      complete: false,
    };
  }

  function withoutPending(receipt: Receipt): Receipt {
    const { pending: _pending, ...rest } = receipt;
    return rest;
  }

  async function bindingResponse(
    stored: StoredBinding,
    worktree: { path: string; branch: string; base: string } | null
  ): Promise<Res<"workspace.prepare">> {
    const path = stored.currentPath ?? stored.path;
    const probed = await port.git(path);
    return {
      path: pathFromWire(path),
      moved: stored.currentPath !== null,
      origin: await store.origin(path),
      checkoutRoot: pathFromWire(stored.checkout.path),
      branch:
        worktree?.branch ??
        (probed && probed !== "error" ? probed.branch : null),
      worktree: worktree
        ? {
            path: pathFromWire(worktree.path),
            branch: worktree.branch,
            base: worktree.base,
          }
        : null,
      ...(probed !== "error" && { git: probed ? wireGit(probed) : null }),
    };
  }

  /** Finish a recorded preparation and bind the session to its worktree. */
  async function finish(
    session: string,
    dir: string,
    receipt: Receipt,
    emit: (p: Progress) => void
  ) {
    let worktree = receipt.worktree;
    if (!worktree) {
      worktree = await makeWorktree(dir, receipt, emit);
      receipt = { ...withoutPending(receipt), worktree };
      await writeReceipt(dir, receipt);
    }
    if ((await port.identity(worktree.path)) !== worktree.identity)
      throw refused("The prepared worktree was removed or replaced.");
    if (!worktree.complete) {
      if ((await port.identity(receipt.source)) !== receipt.sourceIdentity)
        throw refused("The launch directory was moved or replaced.");
      emit({ phase: "copy" });
      await port.copyIgnored(
        receipt.source,
        worktree.path,
        copyNames(receipt.copy ?? [])
      );
      if (receipt.install !== false) {
        emit({ phase: "dependencies" });
        await port.installDependencies(worktree.path, async (step) =>
          emit({ phase: "dependencies", ...step })
        );
      }
      worktree = { ...worktree, complete: true };
      await writeReceipt(dir, { ...receipt, worktree });
    }
    const stored = await store.bindPrepared({
      session,
      path: worktree.path,
      currentPath: null,
      worktree: {
        path: worktree.path,
        branch: worktree.branch,
        base: worktree.base,
      },
    });
    emit({ phase: "ready" });
    return bindingResponse(stored, worktree);
  }

  /** The recorded intent, written now if the caller did not record it first. */
  async function intent(
    dir: string,
    cwd: string,
    request: WorktreeRequest,
    copy: string[],
    install: boolean
  ): Promise<Receipt> {
    const source = await port.canonical(cwd);
    if (!source)
      throw new RunnerCallError({
        code: "not_found",
        message: "Working directory does not exist or is not a directory.",
      });
    const receipt = await readReceipt(dir);
    if (receipt) {
      if (receipt.source !== source || !sameRequest(receipt.request, request))
        throw refused("This launch already owns a different worktree.");
      if (receipt.copy !== undefined && receipt.install !== undefined)
        return receipt;
      // Recorded by a caller (or an older build) without them: this request says.
      const completed = { ...receipt, copy, install };
      await writeReceipt(dir, completed);
      return completed;
    }
    const sourceIdentity = await port.identity(source);
    if (!sourceIdentity)
      throw refused("The launch directory was moved or replaced.");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const recorded: Receipt = {
      cwd,
      source,
      sourceIdentity,
      request,
      copy,
      install,
    };
    await writeReceipt(dir, recorded);
    await syncDirectory(stateRoot);
    return recorded;
  }

  const emitter =
    (context: ConnectionContext) =>
    (progress: Progress): void =>
      context.emit(progress);

  return {
    async "workspace.prepare"(input: Req<"workspace.prepare">, context) {
      const session = sessionToWire(input.session);
      const dir = sessionDir(stateRoot, session);
      if (!("directory" in input.source))
        throw new RunnerCallError({
          code: "unsupported",
          message: "This runner prepares checkouts from a directory only",
        });
      const cwd = displayPath(input.source.directory);
      const emit = emitter(context);
      const copy = [...copyNames(input.copyIgnored)];
      // Checked before anything is recorded.
      if (input.worktree) nestedDir(input.worktree);
      return serialize(session, async () => {
        if (!input.worktree) {
          const directory = await port.canonical(cwd);
          if (!directory)
            throw new RunnerCallError({
              code: "not_found",
              message:
                "Working directory does not exist or is not a directory.",
            });
          const stored = await store.bindPrepared({
            session,
            path: cwd,
            currentPath: null,
            worktree: null,
          });
          emit({ phase: "ready" });
          return bindingResponse(stored, null);
        }
        const receipt = await intent(
          dir,
          cwd,
          input.worktree,
          copy,
          input.installDependencies
        );
        return finish(session, dir, receipt, emit);
      });
    },

    async "workspace.resume"(input: Req<"workspace.resume">, context) {
      const session = sessionToWire(input.session);
      const dir = sessionDir(stateRoot, session);
      const emit = emitter(context);
      return serialize(session, async () => {
        const receipt = await readReceipt(dir);
        if (!receipt) return null;
        return finish(session, dir, receipt, emit);
      });
    },
  };
}
