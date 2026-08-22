import { copyFile, mkdir, readdir, realpath, stat } from "node:fs/promises";
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
 *   - Patterns are relative to the repo root and match top-level names
 *     or one fixed directory prefix. `*` is allowed in the final path
 *     segment only and never crosses a `/`.
 *   - Globs stay narrow. `.env*` would sweep up committed templates and
 *     `*.tfvars` would sweep up committed per-environment values, so
 *     only the auto-loaded Terraform names are matched.
 *
 * Both agent launch paths consume this list — `workspace-prep.ts` for
 * inert mode and `tmux/setup-script.ts` for tmux mode — so they cannot
 * drift apart.
 */
export const WORKTREE_LOCAL_CONFIG_PATTERNS: readonly string[] = [
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
  // Claude Code's per-developer settings (permission allowlists etc).
  ".claude/settings.local.json",
];

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

/**
 * Expand the pattern list against `sourceRoot`, returning repo-relative
 * paths of existing regular files, in pattern order and de-duplicated.
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
 */
export async function copyLocalConfigFiles(
  sourceRoot: string,
  worktreePath: string
): Promise<string[]> {
  const worktreeReal = await realpath(worktreePath).catch(() => null);
  if (!worktreeReal) return [];

  const copied: string[] = [];

  for (const relativePath of await resolveLocalConfigFiles(sourceRoot)) {
    const destination = path.join(worktreePath, relativePath);

    const existing = await stat(destination).catch(() => null);
    if (existing) continue;

    const destinationDir = path.dirname(destination);
    const created = await mkdir(destinationDir, { recursive: true })
      .then(() => true)
      .catch(() => false);
    if (!created) continue;

    // Guard against a tracked symlink in the worktree redirecting a
    // nested destination directory outside the worktree.
    const destinationDirReal = await realpath(destinationDir).catch(() => null);
    if (
      !destinationDirReal ||
      (destinationDirReal !== worktreeReal &&
        !destinationDirReal.startsWith(worktreeReal + path.sep))
    ) {
      continue;
    }

    const ok = await copyFile(path.join(sourceRoot, relativePath), destination)
      .then(() => true)
      .catch(() => false);
    if (ok) copied.push(relativePath);
  }

  return copied;
}
