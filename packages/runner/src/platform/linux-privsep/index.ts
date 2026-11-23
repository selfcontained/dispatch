/*
 * The `linux-privsep` platform: a root supervisor that runs every workload
 * step (Git, the copy list, dependency installs) as a separate account.
 * What it adds to the core so far: where a session's checkout goes and how
 * it is removed (`RepositoryPort.location` / `remove`), the invariant that
 * keeps root's paths out of the workload's reach, and the core's binding
 * store over the supervisor's existing files.
 */
import { dirname, join } from "node:path";
import {
  operations,
  repositoryCheckout,
  RunnerCallError,
  type Req,
  type Res,
} from "@dispatch/runner-protocol/contract";
import {
  RECEIPT_FILE,
  workspaceHandlers,
  type Receipt,
} from "../../core/workspace.js";
import { nodeFs, type PrivsepFs } from "./fs.js";
import {
  PRIVATE_MODE,
  assertProtected,
  layout,
  ownedDirectory,
  storageKey,
  type Ids,
} from "./layout.js";
import { sessionLocation, type WorkloadCommand } from "./location.js";
import { PrivsepBindings } from "./bindings.js";
import type { RepositoryPort, WorkspacePort } from "../types.js";

export { checkoutParentIsProtected, assertProtected } from "./layout.js";
export type { Ids, Layout } from "./layout.js";
export type { WorkloadCommand } from "./location.js";
export { PrivsepBindings } from "./bindings.js";

export type PrivsepOptions = {
  /** The runner state directory, canonical (today's `/var/lib/dispatch-runner/<state>`). */
  state: string;
  ids: Ids;
  asWorkload: WorkloadCommand;
  fs?: PrivsepFs;
};

export async function createLinuxPrivsep(options: PrivsepOptions) {
  const { ids, asWorkload } = options;
  const fs = options.fs ?? nodeFs;
  const paths = layout(options.state);
  // The supervisor made `bindings` at startup; receipts go inside it.
  await ownedDirectory(fs, ids, paths.bindings, PRIVATE_MODE);
  await ownedDirectory(fs, ids, paths.receipts, PRIVATE_MODE);
  const where = sessionLocation(fs, ids, paths, asWorkload);
  return {
    paths,
    bindings: new PrivsepBindings(fs, paths, asWorkload),
    release: where.release,
    /** A clone port with this platform's place for sessions' checkouts. */
    repository(
      clones: Omit<RepositoryPort, "location" | "remove">
    ): RepositoryPort {
      return {
        cache: (url, cache, clone) => clones.cache(url, cache, clone),
        pullRequest: (clone, number, branch) =>
          clones.pullRequest(clone, number, branch),
        location: where.location,
        remove: where.remove,
      };
    },
  };
}

type Operation = "workspace.prepare" | "workspace.resume" | "workspace.release";
type Release = Omit<Req<"workspace.release">, "session">;
type Step = (method: string, args: unknown[]) => Promise<unknown>;

export async function createRemoteWorkspacePreparation(
  options: PrivsepOptions & { step: Step }
) {
  const fs = options.fs ?? nodeFs;
  const platform = await createLinuxPrivsep(options);
  const { paths, bindings } = platform;
  const { ids } = options;
  const step = <T>(method: string, ...args: unknown[]) =>
    options.step(`workspace.${method}`, args) as Promise<T>;
  async function release(
    session: string,
    source: string | null,
    request: Release,
    verify?: (path: string) => Promise<boolean>
  ) {
    const removed = await platform.release(session, source !== null, verify);
    if (removed && source !== null)
      await step(
        "forgetWorktree",
        source,
        bindings.checkoutOf(session),
        request
      );
    return removed;
  }
  const port: WorkspacePort = {
    async release(session, checkout, request) {
      const raw = await fs.read(
        join(paths.receipts, storageKey(session), RECEIPT_FILE)
      );
      if (raw === null) return false;
      const receipt: Receipt = JSON.parse(raw);
      if (
        !receipt.worktree ||
        receipt.at !== checkout.path ||
        receipt.worktree.path !== checkout.path ||
        checkout.path !== bindings.checkoutOf(session)
      )
        return false;
      const identity = receipt.worktree.identity;
      const removed = await release(
        session,
        receipt.source,
        request,
        async (path) => (await port.identity(path)) === identity
      );
      return removed;
    },
    canonical: (path) => step("canonical", path),
    locate: (path) => step("locate", path),
    identity: (path) => step("identity", path),
    plan: (spec) => step("plan", spec),
    create: (spec) => step("create", spec),
    madeForUs: (path, source, branch) =>
      step("madeForUs", path, source, branch),
    copyIgnored: (source, dest, names) =>
      step("copyIgnored", source, dest, names),
    git: (path) => step("git", path),
    async installDependencies(path, report) {
      const result = await step<Parameters<typeof report>[0][]>(
        "installDependencies",
        path
      ).catch(() => [
        {
          status: "failed" as const,
          detail: "Dependency installation could not finish.",
        },
      ]);
      for (const item of result) await report(item);
    },
    repository: platform.repository({
      async cache(url, cache, clone) {
        // Root creates only the direct cache entry. Git and every operation
        // below the entry run as the workload.
        await assertProtected(fs, ids, paths.state, paths.state);
        const parent = await fs.lstat(paths.repositories);
        if (
          !parent ||
          parent.kind !== "directory" ||
          parent.uid !== ids.supervisor ||
          parent.mode !== 0o711 ||
          dirname(cache) !== paths.repositories ||
          !/^[a-f0-9]{64}$/.test(cache.slice(paths.repositories.length + 1)) ||
          (await fs.realpath(paths.repositories)) !== paths.repositories
        )
          throw new RunnerCallError({
            code: "forbidden",
            message: "The repository cache is unavailable.",
          });
        const entry = await fs.lstat(cache);
        if (!entry) await fs.mkdir(cache, PRIVATE_MODE);
        // A supervisor interrupted between mkdir and chown left a private
        // directory behind. The protected parent makes it safe to finish.
        if (
          !entry ||
          (entry.kind === "directory" &&
            entry.uid === ids.supervisor &&
            entry.mode === PRIVATE_MODE)
        )
          await fs.lchown(cache, ids.uid, ids.gid);
        else if (
          entry.kind !== "directory" ||
          entry.uid !== ids.uid ||
          entry.gid !== ids.gid
        )
          throw new RunnerCallError({
            code: "forbidden",
            message: "Invalid repository cache directory.",
          });
        return step("cache", url, cache, clone);
      },
      pullRequest: (clone, number, branch) =>
        step("pullRequest", clone, number, branch),
    }),
  };
  const calls = workspaceHandlers(
    paths.receipts,
    bindings,
    port,
    paths.repositories,
    storageKey
  );
  return {
    legacy: (session: string) => bindings.legacy(session),
    releaseLegacy: release,
    async remove(session: string) {
      const dir = join(paths.receipts, storageKey(session));
      const raw = await fs.read(join(dir, RECEIPT_FILE));
      if (raw === null) return false;
      const receipt: Receipt = JSON.parse(raw);
      await port.repository!.remove!(session);
      // Remove only this worktree's registration. A repository-wide prune
      // could see another session between its plan and Git's worktree add.
      if (receipt.at) await step("forgetWorktree", receipt.source, receipt.at);
      await fs.rm(dir);
      return true;
    },
    async call<K extends Operation>(
      op: K,
      request: Req<K>,
      emit: (value: unknown) => void
    ): Promise<Res<K>> {
      if (!operations[op].request.check(request))
        throw new RunnerCallError({
          code: "invalid",
          message: "Invalid workspace preparation request.",
        });
      if (op === "workspace.prepare") {
        const { source } = request as Req<"workspace.prepare">;
        if (!("repository" in source))
          throw new RunnerCallError({
            code: "unsupported",
            message: "This runner prepares workspaces from a repository.",
          });
        if (
          typeof source.repository !== "string" ||
          !repositoryCheckout.check(source.checkout)
        )
          throw new RunnerCallError({
            code: "invalid",
            message: "Invalid repository checkout.",
          });
      }
      const context = {
        emit,
        receiveBlob: async () => {
          throw new Error("Workspace preparation does not receive blobs.");
        },
      };
      if (op === "workspace.release")
        return (await calls["workspace.release"]!(
          request as Req<"workspace.release">,
          context
        )) as Res<K>;
      const reply =
        op === "workspace.prepare"
          ? await calls["workspace.prepare"]!(
              request as Req<"workspace.prepare">,
              context
            )
          : await calls["workspace.resume"]!(
              request as Req<"workspace.resume">,
              context
            );
      return reply as Res<K>;
    },
  };
}
