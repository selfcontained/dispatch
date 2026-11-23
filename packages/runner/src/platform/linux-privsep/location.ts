/*
 * Where a session's checkout lives on `linux-privsep`, and how it goes:
 * `sessions/<key>/checkout`, today's path, so a running agent's working
 * directory never moves. The parent is the supervisor's (0751, workload
 * group) so the workload can never swap the checkout for a link after the
 * supervisor resolved it; the checkout itself is the workload's, empty
 * until Git (as the workload) makes the worktree in it.
 */
import { join } from "node:path";
import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import type { PrivsepFs } from "./fs.js";
import {
  ANCESTOR_MODE,
  assertProtected,
  checkoutParentIsProtected,
  ownedDirectory,
  storageKey,
  type Ids,
  type Layout,
} from "./layout.js";

/** Runs a command as the verified workload account; throws on failure. */
export type WorkloadCommand = (
  executable: string,
  args: string[],
  options?: { git?: boolean }
) => Promise<string>;

/** A checkout made by Git as the workload with its default umask. */
const CHECKOUT_MODE = 0o755;

const forbidden = (message: string) =>
  new RunnerCallError({ code: "forbidden", message });

export function sessionLocation(
  fs: PrivsepFs,
  ids: Ids,
  paths: Layout,
  asWorkload: WorkloadCommand
) {
  const parentOf = (session: string) =>
    join(paths.sessions, storageKey(session));

  /**
   * A directory as the supervisor found it, gone. One the supervisor owns
   * it removes itself; one the workload owns is emptied by the workload
   * (so root never follows anything the workload put there) and then
   * unlinked from its protected parent. Today's `removeGuestDirectory`.
   */
  async function removeDirectory(dir: string) {
    const entry = await fs.lstat(dir);
    if (!entry) return;
    if (entry.kind !== "directory")
      throw forbidden("Invalid runner session directory.");
    if (entry.uid === ids.supervisor) {
      await fs.rm(dir);
      return;
    }
    await asWorkload("/usr/bin/find", [dir, "-mindepth", "1", "-delete"]);
    await fs.rmdir(dir);
  }

  return {
    /**
     * Create or repair `sessions/<key>` and an empty workload-owned
     * `checkout` in it; return the checkout's path. Refuses a parent that
     * is a link or the workload's, a checkout that is not a directory, and
     * any ancestor the workload could write.
     */
    async location(session: string): Promise<string> {
      await assertProtected(fs, ids, paths.state, paths.sessions);
      const parent = parentOf(session);
      // Made, or an older build's supervisor-owned parent brought to 0751;
      // a link or the workload's own directory is refused.
      await ownedDirectory(fs, ids, parent, ANCESTOR_MODE, ids.gid);
      await assertProtected(fs, ids, paths.state, parent);
      const checkout = join(parent, "checkout");
      const entry = await fs.lstat(checkout);
      if (!entry) {
        await fs.mkdir(checkout, 0o700);
        await fs.lchown(checkout, ids.uid, ids.gid);
        await fs.chmod(checkout, CHECKOUT_MODE);
      } else if (entry.kind !== "directory" || entry.uid !== ids.uid)
        throw forbidden("The runner session checkout is unavailable.");
      if ((await fs.realpath(checkout).catch(() => null)) !== checkout)
        throw forbidden("The runner session checkout is unavailable.");
      return checkout;
    },

    /**
     * Remove the session's checkout and its parent, in today's
     * `discardManagedCheckout` order: the checkout first (as the workload)
     * while its parent still shuts the workload out, then the parent.
     */
    async remove(session: string): Promise<void> {
      const parent = parentOf(session);
      const entry = await fs.lstat(parent);
      if (!entry) return;
      if (checkoutParentIsProtected(entry, ids)) {
        await assertProtected(fs, ids, paths.state, parent);
        await removeDirectory(join(parent, "checkout"));
      }
      await removeDirectory(parent);
    },
  };
}
