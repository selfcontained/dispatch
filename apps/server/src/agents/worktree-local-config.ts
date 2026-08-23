import { copyFile, lstat } from "node:fs/promises";
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
  // direnv.
  ".envrc",
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
 * Both sides are checked with `lstat` rather than `stat`, because a
 * checkout is data and a repository may be untrusted:
 *   - Following a symlinked *source* would make every name a read
 *     primitive pointing anywhere on disk (`.env -> ~/.ssh/id_rsa`),
 *     quietly copying that file somewhere the repo can read it.
 *   - Following a symlinked *destination* would make every name a write
 *     primitive. A dangling link is the sharp case: it is invisible to
 *     an existence check but `copyFile` would still follow it and
 *     create the target outside the worktree.
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
    const source = path.join(sourceRoot, name);
    const sourceStats = await lstat(source).catch(() => null);
    if (!sourceStats?.isFile()) continue;

    const destination = path.join(worktreePath, name);
    const existing = await lstat(destination).catch(() => null);
    if (existing) continue;

    const ok = await copyFile(source, destination)
      .then(() => true)
      .catch(() => false);
    if (ok) copied.push(name);
  }

  return copied;
}
