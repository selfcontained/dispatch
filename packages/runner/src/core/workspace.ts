import { isDeepStrictEqual } from "node:util";
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
 *
 * A repository source is the same preparation from a directory the runner
 * makes itself: a clone cached per repository (keyed by its identity, so
 * every spelling of its URL shares one), fetched on each use, and the
 * session's worktree made from it (beside it, or where the platform's
 * `location` says) by the directory steps above,
 * with main's branch rules. The receipt records the repository too, so a
 * repeat or `resume` finishes the same checkout.
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
  repositoryCheckout,
  worktreeRequest,
} from "@dispatch/runner-protocol/contract";
import type { CallHandlers, ConnectionContext } from "../handlers.js";
import {
  git,
  isLinkedWorktreeRoot,
  type BindingStore,
  type StoredBinding,
} from "../local/bindings.js";
import type {
  CheckoutGit,
  RepositoryPort,
  WorkspacePort,
  WorktreeSpec,
} from "../platform/types.js";
import {
  repositoryIdentity,
  repositoryKey,
  repositoryName,
  storableUrl,
} from "./repository.js";

type WorktreeRequest = Infer<typeof worktreeRequest>;
type RepositoryCheckout = Infer<typeof repositoryCheckout>;
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
  /** Session whose current folder supplied this independent checkout. */
  parent?: string;
  /** Ignored files to copy from the source; absent in older receipts. */
  copy?: string[];
  /** Whether dependencies are installed; absent means yes. */
  install?: boolean;
  /**
   * For a repository source: its identity, the checkout asked for, and the
   * URL as stored (no credentials; absent in older receipts).
   */
  repository?: {
    identity: string;
    checkout: RepositoryCheckout;
    url?: string;
  };
  /** The path the platform chose for the worktree (`RepositoryPort.location`). */
  at?: string;
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
    ...(receipt.at === undefined
      ? { nested: nestedDir(request) }
      : {
          at: receipt.at,
          ...(!receipt.repository && { fromDirectory: true }),
        }),
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

/** Uses of each cached clone, per cache root: one at a time, whoever asks. */
const cacheQueues = new Map<string, Map<string, Promise<unknown>>>();
/** Clones this process has already made or fetched, per cache root. */
const cachedClones = new Map<string, Set<string>>();

async function useCache<T>(
  repositories: string,
  key: string,
  action: () => Promise<T>
): Promise<T> {
  let caches = cacheQueues.get(repositories);
  if (!caches) cacheQueues.set(repositories, (caches = new Map()));
  const current = (caches.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(action);
  caches.set(key, current);
  try {
    return await current;
  } finally {
    if (caches.get(key) === current) caches.delete(key);
  }
}

/**
 * The cached clone of a repository, the one a launch from that repository
 * uses: the same key, the same directory, the same platform step (the
 * workload's own Git, configuration and credentials), serialised with
 * launches. The first use in this process makes or fetches it; later reads
 * leave fetching to the reader (`checkout.defaultFiles` fetches the
 * remote's default branch on its own schedule).
 */
export function repositoryClone(
  repository: RepositoryPort,
  repositories: string
): (url: string) => Promise<string> {
  return async (url) => {
    const identity = repositoryIdentity(url);
    if (!identity)
      throw new RunnerCallError({
        code: "invalid",
        message: "Not a repository URL.",
      });
    const key = repositoryKey(identity);
    const cache = join(repositories, key);
    const clone = join(cache, repositoryName(identity));
    let ready = cachedClones.get(repositories);
    if (!ready) cachedClones.set(repositories, (ready = new Set()));
    const made = ready;
    await useCache(repositories, key, async () => {
      if (made.has(key)) return;
      await repository.cache(storableUrl(url), cache, clone);
      made.add(key);
    });
    return clone;
  };
}

export function workspaceHandlers(
  stateRoot: string,
  store: Pick<
    BindingStore,
    "get" | "origin" | "bindPrepared" | "borrow" | "select"
  > &
    Partial<Pick<BindingStore, "forget">>,
  port: WorkspacePort,
  /** Where cached clones live; the workload account must be able to write it. */
  repositories = join(stateRoot, "repositories"),
  receiptKey = (session: string) => session
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
      const check = port.madeForUs?.bind(port) ?? madeForUs;
      if (await check(path, receipt.source, branch)) made = { path, branch };
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

  /** A selection's answer: the folder the session now works in and its Git facts. */
  async function selection(
    stored: StoredBinding,
    path: string,
    probed: CheckoutGit | null
  ): Promise<Res<"workspace.select">> {
    return {
      path: pathFromWire(path),
      moved: stored.currentPath !== null,
      origin: await store.origin(path),
      repositoryRoot: probed ? pathFromWire(probed.repoRoot) : null,
      checkoutRoot: pathFromWire(stored.checkout.path),
      branch: probed?.branch ?? null,
      git: probed ? wireGit(probed) : null,
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
      // The platform's place for it is made (or repaired) before Git runs,
      // and must still be the one recorded.
      if (
        receipt.at !== undefined &&
        (await port.repository?.location?.(session)) !== receipt.at
      )
        throw refused("The prepared worktree's location changed.");
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
    install: boolean,
    repository?: Receipt["repository"],
    at?: string,
    parent?: string
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
      ...(repository && { repository }),
      ...(at !== undefined && { at }),
      ...(parent !== undefined && { parent }),
    };
    await writeReceipt(dir, recorded);
    await syncDirectory(stateRoot);
    return recorded;
  }

  const inCache = <T>(key: string, action: () => Promise<T>) =>
    useCache(repositories, key, action);

  /** The worktree a repository checkout asks for, by main's branch rules. */
  function repositoryRequest(
    checkout: RepositoryCheckout,
    defaultBranch: string | null,
    name: string | undefined
  ): WorktreeRequest {
    const fallback = () => {
      if (!defaultBranch)
        throw refused("The remote repository has no default branch.");
      return defaultBranch;
    };
    switch (checkout.kind) {
      case "new":
        return {
          name: name ?? checkout.branch,
          branch: checkout.branch,
          base: checkout.base ?? fallback(),
          create: true,
        };
      case "default": {
        const branch = fallback();
        return { name: name ?? branch, branch, base: branch, create: false };
      }
      case "branch":
      case "pr":
        return {
          name: name ?? checkout.branch,
          branch: checkout.branch,
          base: checkout.branch,
          create: false,
        };
    }
  }

  /** Prepare from a repository: the cached clone, then its worktree. */
  async function fromRepository(
    session: string,
    dir: string,
    input: Req<"workspace.prepare">,
    source: { repository: string; checkout: RepositoryCheckout },
    emit: (p: Progress) => void
  ) {
    const repository = port.repository;
    if (!repository)
      throw new RunnerCallError({
        code: "unsupported",
        message: "This runner does not prepare checkouts from a repository",
      });
    const identity = repositoryIdentity(source.repository);
    if (!identity)
      throw new RunnerCallError({
        code: "invalid",
        message: "Not a repository URL.",
      });
    const sameCheckout = (r: Receipt) =>
      r.repository?.identity === identity &&
      isDeepStrictEqual(r.repository.checkout, source.checkout);
    const recorded = await readReceipt(dir);
    if (recorded) {
      if (!sameCheckout(recorded))
        throw refused("This launch already owns a different worktree.");
      return finish(session, dir, recorded, emit);
    }
    const key = repositoryKey(identity);
    const cache = join(repositories, key);
    const clone = join(cache, repositoryName(identity));
    const url = storableUrl(source.repository);
    emit({ phase: "workspace" });
    const request = await inCache(key, async () => {
      const { defaultBranch } = await repository.cache(url, cache, clone);
      const wanted = repositoryRequest(
        source.checkout,
        defaultBranch,
        input.worktree?.name
      );
      if (source.checkout.kind === "pr")
        await repository.pullRequest(
          clone,
          source.checkout.number,
          source.checkout.branch
        );
      return wanted;
    });
    // Where the platform keeps sessions' checkouts, when it says; beside
    // the clone otherwise.
    const at = repository.location
      ? await repository.location(session)
      : undefined;
    const receipt = await intent(
      dir,
      clone,
      request,
      [...copyNames(input.copyIgnored)],
      input.installDependencies,
      { identity, checkout: source.checkout, url },
      at
    );
    return finish(session, dir, receipt, emit);
  }

  // An interrupted preparation may own a worktree before its binding was written.
  // Read its receipt without completing dependencies or creating another checkout.
  async function interrupted(session: string) {
    const dir = sessionDir(stateRoot, receiptKey(session));
    const receipt = await readReceipt(dir);
    if (!receipt) return null;
    const checkout = receipt.worktree ?? receipt.pending;
    if (!checkout) return { dir, receipt, checkout: null };
    const identity = await port.identity(checkout.path);
    if (identity) {
      if (receipt.worktree) {
        if (identity !== receipt.worktree.identity)
          throw refused("The prepared worktree was removed or replaced.");
      } else {
        if (
          (await port.identity(receipt.source)) !== receipt.sourceIdentity ||
          !(await (port.madeForUs ?? madeForUs)(
            checkout.path,
            receipt.source,
            checkout.branch
          ))
        )
          throw refused("The prepared worktree was removed or replaced.");
      }
    }
    return {
      dir,
      receipt,
      checkout: identity
        ? { path: checkout.path, identity, branch: checkout.branch }
        : null,
    };
  }

  const emitter =
    (context: ConnectionContext) =>
    (progress: Progress): void =>
      context.emit(progress);

  return {
    async "workspace.release"(input: Req<"workspace.release">) {
      const session = sessionToWire(input.session);
      return serialize(session, async () => {
        const held = await store.get(session);
        if (!held) {
          const pending = await interrupted(session);
          if (!pending) return { removed: true };
          if (pending.checkout) {
            if (!port.release)
              throw new RunnerCallError({
                code: "unsupported",
                message: "This runner does not release bound checkouts.",
              });
            const removed = await port.release(session, pending.checkout, {
              deleteBranch:
                input.deleteBranch || pending.receipt.request.create,
              originalBranch: input.originalBranch ?? pending.checkout.branch,
            });
            if (!removed) return { removed: false };
          }
          await rm(join(pending.dir, RECEIPT_FILE), { force: true });
          await store.forget?.(session);
          return { removed: true };
        }
        if (held.checkout.ownership === "external") return { removed: false };
        if (!port.release || !store.forget)
          throw new RunnerCallError({
            code: "unsupported",
            message: "This runner does not release bound checkouts.",
          });
        const dir = sessionDir(stateRoot, receiptKey(session));
        const { deleteBranch, originalBranch } = input;
        const removed =
          held.checkout.ownership === "gone" ||
          (await port.release(session, held.checkout, {
            deleteBranch,
            originalBranch,
          }));
        if (removed) {
          await rm(join(dir, RECEIPT_FILE), { force: true });
          await store.forget(session);
        }
        return { removed };
      });
    },

    /**
     * What the session's binding says it may remove, and the checkout's
     * state for the caller's decision. Owned (or owned and gone): the
     * session's own checkout; borrowed: another session's folder; external:
     * never the runner's to remove. The caller decides; nothing changes.
     */
    async "workspace.observe"(input: Req<"workspace.observe">) {
      const session = sessionToWire(input.session);
      return serialize(session, async () => {
        const held = await store.get(session);
        if (!held) {
          const pending = await interrupted(session);
          if (!pending)
            throw new RunnerCallError({
              code: "not_found",
              message: "No checkout is bound to this session",
            });
          const state =
            pending.checkout && input.policy !== "ownership"
              ? await port.observe?.(pending.checkout.path)
              : null;
          return {
            ownership: "owned" as const,
            owner: session,
            borrowers: [],
            checkout: state
              ? { ...state, path: pathFromWire(state.path) }
              : null,
          };
        }
        if (held.borrowedFrom)
          return {
            ownership: "borrowed" as const,
            owner: held.borrowedFrom,
            borrowers: [],
            checkout: null,
          };
        if (held.checkout.ownership === "external")
          return {
            ownership: "external" as const,
            owner: null,
            borrowers: [],
            checkout: null,
          };
        // `ownership` asks who owns it, not its state: nothing is read.
        let state = null;
        if (
          held.checkout.ownership === "owned" &&
          input.policy !== "ownership"
        ) {
          if (!port.observe)
            throw new RunnerCallError({
              code: "failed",
              message: "Checkout observation is unavailable.",
            });
          state = await port.observe(held.checkout.path);
        }
        return {
          ownership: "owned" as const,
          owner: session,
          borrowers: [],
          checkout: state && { ...state, path: pathFromWire(state.path) },
        };
      });
    },

    /**
     * A file the caller hands the session where it is, on a transport that
     * passes a path in place (the local socket): nothing is read or copied.
     * The bytes of a file are not received here.
     */
    async "files.put"(input: Req<"files.put">, context) {
      // Registered before any await: the frame may follow the request.
      const taken = context.receiveBlobPath?.(input.blob);
      taken?.catch(() => {});
      if (!taken || !port.putFile)
        throw new RunnerCallError({
          code: "unsupported",
          message: "This runner takes session files in place only.",
        });
      if (!(await store.get(sessionToWire(input.session))))
        throw new RunnerCallError({
          code: "not_found",
          message: "No checkout is bound to this session",
        });
      const { path, mustExist } = await taken;
      return { path: pathFromWire(await port.putFile(path, { mustExist })) };
    },

    ...(port.launchProbes && {
      "path.complete": port.launchProbes.complete,
      "git.remoteHeads": port.launchProbes.remoteHeads,
    }),

    async "path.resolve"(input: Req<"path.resolve">) {
      if (input.automatic) {
        if (!port.launchProbes)
          throw new RunnerCallError({
            code: "unsupported",
            message: "This runner does not inspect launch folders.",
          });
        return port.launchProbes.inspect(input.path);
      }
      if (!port.resolvePath)
        throw new RunnerCallError({
          code: "unsupported",
          message: "This runner does not resolve launch folders.",
        });
      const { path, ...options } = input;
      return port.resolvePath(path, options);
    },

    async "workspace.prepare"(input: Req<"workspace.prepare">, context) {
      const session = sessionToWire(input.session);
      const dir = sessionDir(stateRoot, receiptKey(session));
      const emit = emitter(context);
      if ("repository" in input.source) {
        const source = input.source;
        copyNames(input.copyIgnored);
        return serialize(session, async () => {
          if ((await store.get(session))?.borrowedFrom)
            throw refused("This launch already owns a different worktree.");
          return fromRepository(session, dir, input, source, emit);
        });
      }
      if ("session" in input.source) {
        const parent = sessionToWire(input.source.session);
        if (parent === session)
          throw refused("A session cannot borrow itself.", 400);
        const copy = [...copyNames(input.copyIgnored)];
        const request = input.worktree;
        if (request) nestedDir(request);
        return serialize(session, async () => {
          const receipt = await readReceipt(dir);
          if (receipt) {
            if (
              !request ||
              receipt.parent !== parent ||
              !sameRequest(receipt.request, request)
            )
              throw refused("This launch already owns a different worktree.");
            return finish(session, dir, receipt, emit);
          }
          const held = await store.get(session);
          const existing = held?.source === "prepare" ? held : null;
          if (existing && (request || existing.borrowedFrom !== parent))
            throw refused("This launch already owns a different worktree.");
          const source = existing ?? (await store.get(parent));
          if (!source)
            throw new RunnerCallError({
              code: "not_found",
              message: "No checkout is bound to this session",
            });
          const cwd = source.currentPath ?? source.path;
          if (!request) {
            const binding =
              existing ?? (await store.borrow(session, parent, cwd));
            emit({ phase: "ready" });
            return bindingResponse(binding, null);
          }
          const recorded = await intent(
            dir,
            cwd,
            request,
            copy,
            input.installDependencies,
            undefined,
            await port.repository?.location?.(session),
            parent
          );
          return finish(session, dir, recorded, emit);
        });
      }
      if (!("directory" in input.source))
        throw new RunnerCallError({
          code: "unsupported",
          message:
            "This runner prepares checkouts from a directory or a repository only",
        });
      const cwd = displayPath(input.source.directory);
      const copy = [...copyNames(input.copyIgnored)];
      // Checked before anything is recorded.
      if (input.worktree) nestedDir(input.worktree);
      return serialize(session, async () => {
        if ((await store.get(session))?.borrowedFrom)
          throw refused("This launch already owns a different worktree.");
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
          input.installDependencies,
          undefined,
          await port.repository?.location?.(session)
        );
        return finish(session, dir, receipt, emit);
      });
    },

    /**
     * Move the session into another folder its account can use, or back
     * to its checkout with `null`. Main's rule: the folder must be a
     * directory; inside Git the session moves to that checkout's root; the
     * checkout itself (canonically) is no move. Only `currentPath` is
     * recorded; the checkout and its ownership stay as they are.
     */
    async "workspace.select"(input: Req<"workspace.select">) {
      const session = sessionToWire(input.session);
      return serialize(session, async () => {
        const held = await store.get(session);
        if (!held)
          throw new RunnerCallError({
            code: "not_found",
            message: "No checkout is bound to this session",
          });
        let path = held.checkout.path;
        let current: string | null = null;
        let probed: CheckoutGit | null;
        if (input.path === null) {
          const git = await port.git(path);
          probed = git === "error" ? null : git;
        } else {
          const requested = displayPath(input.path);
          if (!isAbsolute(requested))
            throw refused("Workspace path must be absolute.", 400);
          const found = await port.locate(requested);
          if (found === "not_directory")
            throw refused(`${requested} is not a directory.`, 400);
          if (found === "missing")
            throw refused(`${requested} does not exist.`, 400);
          const git = await port.git(found.directory);
          if (git === "error")
            throw refused(
              `Could not read git state in ${found.directory}.`,
              400
            );
          probed = git;
          path = git?.worktreePath ?? found.directory;
          const home =
            (await port.canonical(held.checkout.path)) ??
            resolve(held.checkout.path);
          if (path !== home) current = path;
        }
        const stored = await store.select(session, current);
        return selection(stored ?? held, path, probed);
      });
    },

    async "workspace.resume"(input: Req<"workspace.resume">, context) {
      const session = sessionToWire(input.session);
      const dir = sessionDir(stateRoot, receiptKey(session));
      const emit = emitter(context);
      return serialize(session, async () => {
        const receipt = await readReceipt(dir);
        if (!receipt) return null;
        return finish(session, dir, receipt, emit);
      });
    },
  };
}
