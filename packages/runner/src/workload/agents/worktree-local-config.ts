import { constants, open } from "node:fs/promises";
import path from "node:path";

/**
 * Copy the listed files that exist in `sourceRoot` into `worktreePath`,
 * returning what was copied. Best-effort: a missing source is a no-op
 * and a failure is skipped, since a worktree missing one is still usable.
 *
 * An existing destination is never overwritten — a fresh worktree holds
 * exactly the tracked files, so a name that is already there is one the
 * repo commits, and the checked-out revision beats the source checkout's
 * possibly-dirty copy.
 *
 * A checkout is data and a repo may be untrusted, so nothing is checked
 * by path and then acted on by path: a symlink swapped into that window
 * turns every name into a read primitive (`.env -> ~/.ssh/id_rsa`) or a
 * write primitive escaping the worktree. Hence `O_NOFOLLOW` on the
 * source, `O_CREAT | O_EXCL` on the destination, and every subsequent
 * operation on the resulting descriptor.
 *
 * The former bash setup script mirrored this, with one gap it documented:
 * a shell has no no-follow open.
 */
export async function copyLocalConfigFiles(
  sourceRoot: string,
  worktreePath: string,
  names: readonly string[]
): Promise<string[]> {
  const copied: string[] = [];

  for (const name of names) {
    const sourceHandle = await open(
      path.join(sourceRoot, name),
      constants.O_RDONLY | constants.O_NOFOLLOW
    ).catch(() => null);
    if (!sourceHandle) continue;

    const destination = path.join(worktreePath, name);
    try {
      const stats = await sourceHandle.stat();
      if (!stats.isFile()) continue;
      const contents = await sourceHandle.readFile();

      // EEXIST here covers a regular file, a live symlink and a dangling
      // one alike. Mode is set at creation because a later `chmod` would
      // follow a link swapped in after the file was created.
      const destinationHandle = await open(
        destination,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600
      ).catch(() => null);
      if (!destinationHandle) continue;

      try {
        await destinationHandle.writeFile(contents);
        copied.push(name);
      } catch {
        // Don't leave a truncated secret behind. Truncating through the
        // descriptor can't hit an entry that replaced ours; unlinking by
        // path could.
        await destinationHandle.truncate(0).catch(() => {});
      } finally {
        await destinationHandle.close();
      }
    } catch {
      // Best-effort.
    } finally {
      await sourceHandle.close();
    }
  }

  return copied;
}
