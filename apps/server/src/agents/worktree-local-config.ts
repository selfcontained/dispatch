import { constants, open } from "node:fs/promises";
import path from "node:path";

/**
 * Local config/secret files copied from the source repo into a freshly
 * created worktree.
 *
 * Git only carries *tracked* files into a new worktree, so anything a
 * developer keeps gitignored — API keys, local overrides, framework
 * secrets — silently goes missing and the agent's first command fails
 * in a confusing way. These are the filenames different ecosystems
 * conventionally gitignore for exactly that purpose.
 *
 * Rules for this list:
 *   - Exact top-level filenames only. No globs and no directory
 *     components: the tmux launch path hands these to bash and the
 *     inert path to `fs`, and literal names are the only form both
 *     agree on without either side interpreting anything.
 *   - Only names that are *conventionally gitignored*. Committed
 *     template files (`.env.example`, `.env.sample`) are already in the
 *     worktree via the checkout, so listing them would be pure noise.
 *   - Only files that actually fix the failure on their own. `.envrc`
 *     was considered and rejected: direnv will not load it until the
 *     new worktree is approved, and approving it automatically would
 *     execute repository-controlled code, so copying it duplicates a
 *     secret without restoring anything.
 *   - Only files that are configuration. Anything that grants the
 *     launched agent capabilities it wouldn't otherwise have belongs
 *     nowhere near this list — `.claude/settings.local.json` was
 *     considered and rejected on exactly those grounds, since copying a
 *     permission allowlist would quietly widen what a `fullAccess:
 *     false` launch can do.
 *
 * Both agent launch paths consume this list — `workspace-prep.ts` for
 * inert mode and `tmux/setup-script.ts` for tmux mode — so they cannot
 * drift apart.
 */
const FILES: readonly string[] = [
  // dotenv, plus the `.local` override convention shared by Next.js,
  // Vite, CRA and friends. Spelled out rather than globbed — these are
  // the conventional ones and there is no fourth.
  ".env",
  ".env.local",
  ".env.development.local",
  ".env.production.local",
  ".env.test.local",
  // Cloudflare Wrangler local secrets.
  ".dev.vars",
  // Registry auth tokens — copied before the dependency install step so
  // private-registry installs in the worktree work.
  ".npmrc",
  // Azure Functions local settings.
  "local.settings.json",
  // Terraform's auto-loaded variable files. `*.auto.tfvars` is
  // deliberately absent: its prefix is arbitrary, so covering it would
  // mean globbing.
  "terraform.tfvars",
  "terraform.tfvars.json",
];

/**
 * Enforce that an entry really is a plain top-level filename.
 *
 * The two launch paths only agree for free while nothing has to be
 * interpreted — a directory component or a `*` would be expanded by
 * bash and looked up literally by `fs`, which is precisely the drift
 * this module exists to prevent. A violation is a bug in the list
 * above, not user error, so it throws when the list is defined.
 */
export function assertTopLevelFileName(name: string): string {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    !/^[A-Za-z0-9._-]+$/.test(name)
  ) {
    throw new Error(
      `Unsafe worktree local-config filename: ${JSON.stringify(name)}`
    );
  }
  return name;
}

export const WORKTREE_LOCAL_CONFIG_FILES: readonly string[] = FILES.map(
  assertTopLevelFileName
);

/**
 * Copy the local config files that exist in `sourceRoot` into
 * `worktreePath`, returning the filenames actually copied.
 *
 * Best-effort throughout: a missing source file is a no-op and an
 * individual copy failure is skipped rather than thrown, because a
 * worktree without one of these is still usable.
 *
 * A destination that already exists is never overwritten. A freshly
 * created worktree contains exactly the files git tracks, so an
 * existing destination means the repo commits that name — and the
 * checked-out revision's copy is the correct one, not the source
 * checkout's possibly-dirty, possibly-different-branch version.
 *
 * Symlinks are refused on both sides, because a checkout is data and a
 * repository may be untrusted. Neither side is tested by path and then
 * acted on by path — every check happens on the descriptor that the
 * copy itself uses, so there is no window to swap a link into:
 *   - The *source* is opened `O_NOFOLLOW`. Following a symlink there
 *     would make every name a read primitive pointing anywhere on disk
 *     (`.env -> ~/.ssh/id_rsa`), quietly copying that file somewhere the
 *     repo can read it.
 *   - The *destination* is created `O_CREAT | O_EXCL`, at mode 0600.
 *     Following a symlink there would make every name a write primitive,
 *     and a dangling link is the sharp case: invisible to an existence
 *     test, yet still followed by the copy.
 *
 * The tmux path cannot match the source half of this — a shell has no
 * no-follow open — so it still tests `-L` by path. That defends against
 * a checkout that *contains* a symlink, which is the realistic case, but
 * not against a process mutating the source repo during the milliseconds
 * of setup. See `tmux/setup-script.ts`.
 *
 * `tmux/setup-script.ts` implements the same rules in bash for the
 * tmux launch path.
 */
export async function copyLocalConfigFiles(
  sourceRoot: string,
  worktreePath: string
): Promise<string[]> {
  const copied: string[] = [];

  for (const name of WORKTREE_LOCAL_CONFIG_FILES) {
    // Open the source with `O_NOFOLLOW` and read through the descriptor.
    // Checking the path with `lstat` and then opening it again would be a
    // check-then-open pair: a symlink swapped in between the two would be
    // followed by the open, which is the read primitive this refuses.
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

      // `O_CREAT | O_EXCL` is the destination guarantee, not a pre-flight
      // check: it fails with EEXIST for a regular file, a live symlink and
      // a dangling one alike, so an existing name is never overwritten and
      // a symlinked one is never followed. The mode is set at creation
      // rather than by a later `chmod`, because a path-based `chmod` would
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
        // descriptor keeps this anchored to the file we created — a
        // path-based unlink here could remove a different entry that
        // replaced ours in the meantime.
        await destinationHandle.truncate(0).catch(() => {});
      } finally {
        await destinationHandle.close();
      }
    } catch {
      // Best-effort: a worktree missing one of these is still usable.
    } finally {
      await sourceHandle.close();
    }
  }

  return copied;
}
