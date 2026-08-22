import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
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
 *   - Only names that are *conventionally gitignored*. Committed
 *     template files (`.env.example`, `.env.sample`) are already in the
 *     worktree via the checkout, so matching them would be pure noise.
 *   - Only files that are configuration. Anything that grants the
 *     launched agent capabilities it wouldn't otherwise have belongs
 *     nowhere near this list — `.claude/settings.local.json` was
 *     considered and rejected on exactly those grounds, since copying a
 *     permission allowlist would quietly widen what a `fullAccess:
 *     false` launch can do.
 *   - Patterns are relative to the repo root and match top-level names
 *     or one fixed directory prefix. `*` is allowed in the final path
 *     segment only and never crosses a `/`. `assertSafeLocalConfigPattern`
 *     enforces that grammar, so a future addition cannot mean one thing
 *     to the bash launch path and another to the TypeScript one.
 *   - Globs stay narrow. `.env*` would sweep up committed templates and
 *     `*.tfvars` would sweep up committed per-environment values, so
 *     only the auto-loaded Terraform names are matched.
 *
 * Both agent launch paths consume this list — `workspace-prep.ts` for
 * inert mode and `tmux/setup-script.ts` for tmux mode — so they cannot
 * drift apart.
 */
const PATTERNS: readonly string[] = [
  // dotenv, and the `.local` override convention shared by Next.js,
  // Vite, CRA and friends.
  ".env",
  ".env.local",
  ".env.*.local",
  // Cloudflare Wrangler local secrets.
  ".dev.vars",
  // direnv.
  ".envrc",
  // Registry auth tokens — copied before the dependency install step so
  // private-registry installs in the worktree work.
  ".npmrc",
  // Azure Functions local settings.
  "local.settings.json",
  // Terraform's auto-loaded variable files.
  "terraform.tfvars",
  "terraform.tfvars.json",
  "*.auto.tfvars",
  "*.auto.tfvars.json",
  // Rails encrypted-credentials keys.
  "config/master.key",
  "config/credentials/*.key",
  // Streamlit.
  ".streamlit/secrets.toml",
];

// Directory segments are literal; only the final segment may glob. Both
// exclude the shell metacharacters that would change meaning when the
// pattern is interpolated unquoted into the generated bash.
const DIRECTORY_SEGMENT = /^[A-Za-z0-9._-]+$/;
const FINAL_SEGMENT = /^[A-Za-z0-9._*-]+$/;

/**
 * Enforce the pattern grammar the whole module is documented against:
 * a relative path, literal directory segments, and `*` only in the
 * final segment.
 *
 * This lives with the list rather than with either consumer because the
 * two launch paths interpret patterns differently — bash hands them to
 * the shell's globber, `resolveLocalConfigFiles` only wildcards the
 * basename. A pattern like `config/*​/secret` would expand in one and be
 * looked up literally in the other, which is precisely the drift this
 * module exists to prevent. A violation is a bug in the list above, not
 * user error, so it throws when the list is defined.
 */
export function assertSafeLocalConfigPattern(pattern: string): string {
  const segments = pattern.split("/");
  const finalSegment = segments[segments.length - 1] ?? "";
  const valid =
    pattern.length > 0 &&
    !path.isAbsolute(pattern) &&
    segments.slice(0, -1).every((segment) => DIRECTORY_SEGMENT.test(segment)) &&
    FINAL_SEGMENT.test(finalSegment) &&
    segments.every((segment) => segment !== "." && segment !== "..");
  if (!valid) {
    throw new Error(
      `Unsafe worktree local-config pattern: ${JSON.stringify(pattern)}`
    );
  }
  return pattern;
}

export const WORKTREE_LOCAL_CONFIG_PATTERNS: readonly string[] = PATTERNS.map(
  assertSafeLocalConfigPattern
);

/**
 * Turn the final segment of a pattern into an anchored RegExp. `*` is
 * the only wildcard and never matches a path separator.
 */
function segmentMatcher(segment: string): RegExp {
  const source = segment.replace(/[.*+?^${}()|[\]\\]/g, (char) =>
    char === "*" ? "[^/]*" : `\\${char}`
  );
  return new RegExp(`^${source}$`);
}

/** Is `candidate` the directory `root`, or something underneath it? */
function isContainedIn(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * Expand the pattern list against `sourceRoot`, returning repo-relative
 * paths of existing regular files, in pattern order and de-duplicated.
 *
 * This answers "which names match", not "which are safe to copy" —
 * `copyLocalConfigFiles` applies the symlink rules.
 */
export async function resolveLocalConfigFiles(
  sourceRoot: string
): Promise<string[]> {
  const matches: string[] = [];
  const seen = new Set<string>();

  const add = (relativePath: string) => {
    if (seen.has(relativePath)) return;
    seen.add(relativePath);
    matches.push(relativePath);
  };

  for (const pattern of WORKTREE_LOCAL_CONFIG_PATTERNS) {
    const dir = path.dirname(pattern);
    const base = path.basename(pattern);

    if (!base.includes("*")) {
      const stats = await stat(path.join(sourceRoot, pattern)).catch(
        () => null
      );
      if (stats?.isFile()) add(pattern);
      continue;
    }

    const matcher = segmentMatcher(base);
    const entries = await readdir(path.join(sourceRoot, dir), {
      withFileTypes: true,
    }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!matcher.test(entry.name)) continue;
      const relativePath =
        dir === "." ? entry.name : path.join(dir, entry.name);
      const stats = await stat(path.join(sourceRoot, relativePath)).catch(
        () => null
      );
      if (stats?.isFile()) add(relativePath);
    }
  }

  return matches;
}

/**
 * Copy the matched local config files from `sourceRoot` into
 * `worktreePath`, returning the repo-relative paths actually copied.
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
 * repository may be untrusted:
 *   - A symlinked *source* would make every pattern a read primitive
 *     pointing anywhere on disk (`.env -> ~/.ssh/id_rsa`), quietly
 *     copying that file somewhere the repo can read it.
 *   - A symlinked *destination* would make every pattern a write
 *     primitive. A dangling link in particular passes an existence
 *     check, so it is tested for explicitly.
 * The directory components on each side are canonicalized and required
 * to stay inside their own root, which covers a symlink one level up.
 *
 * `tmux/setup-script.ts` implements the same rules in bash for the
 * tmux launch path.
 */
export async function copyLocalConfigFiles(
  sourceRoot: string,
  worktreePath: string
): Promise<string[]> {
  const worktreeReal = await realpath(worktreePath).catch(() => null);
  const sourceReal = await realpath(sourceRoot).catch(() => null);
  if (!worktreeReal || !sourceReal) return [];

  const copied: string[] = [];

  for (const relativePath of await resolveLocalConfigFiles(sourceRoot)) {
    const source = path.join(sourceRoot, relativePath);
    const destination = path.join(worktreePath, relativePath);

    // Source side: a regular file reached through real directories.
    const sourceStats = await lstat(source).catch(() => null);
    if (!sourceStats?.isFile()) continue;
    const sourceDirReal = await realpath(path.dirname(source)).catch(
      () => null
    );
    if (!sourceDirReal || !isContainedIn(sourceDirReal, sourceReal)) continue;

    // Destination side: nothing there already — `lstat`, so a dangling
    // symlink counts as present rather than being followed by the copy.
    const existing = await lstat(destination).catch(() => null);
    if (existing) continue;

    const destinationDir = path.dirname(destination);
    const created = await mkdir(destinationDir, { recursive: true })
      .then(() => true)
      .catch(() => false);
    if (!created) continue;

    const destinationDirReal = await realpath(destinationDir).catch(() => null);
    if (!destinationDirReal || !isContainedIn(destinationDirReal, worktreeReal))
      continue;

    const ok = await copyFile(source, destination)
      .then(() => true)
      .catch(() => false);
    if (ok) copied.push(relativePath);
  }

  return copied;
}
