/*
 * The `linux-privsep` platform: a root supervisor that runs every workload
 * step (Git, the copy list, dependency installs) as a separate account.
 * What it adds to the core so far: where a session's checkout goes and how
 * it is removed (`RepositoryPort.location` / `remove`), the invariant that
 * keeps root's paths out of the workload's reach, and the core's binding
 * store over the supervisor's existing files.
 */
import { nodeFs, type PrivsepFs } from "./fs.js";
import { PRIVATE_MODE, layout, ownedDirectory, type Ids } from "./layout.js";
import { sessionLocation, type WorkloadCommand } from "./location.js";
import { PrivsepBindings } from "./bindings.js";
import type { RepositoryPort } from "../types.js";

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
