import { constants, lstat, open } from "node:fs/promises";
import path from "node:path";

import { runCommand } from "../shared/lib/run-command.js";

/**
 * Gitignored local config copied into a new worktree, because `git
 * worktree add` only materializes tracked files — so a developer's
 * secrets silently go missing and the agent's first command fails oddly.
 * Consumed by both launch paths (`workspace-prep.ts` for inert mode,
 * `tmux/setup-script.ts` for tmux) so they cannot drift apart.
 *
 * Additions must be conventionally gitignored, must be fixed by copying
 * alone, and must not grant the agent new capabilities. The ignore rule
 * is enforced at runtime, not assumed — see `copyLocalConfigFiles`. Two entries were
 * considered and rejected on the last two rules, so don't re-add them:
 * `.envrc`, because direnv won't load it until the worktree is approved
 * and auto-approving would run repo-controlled code; and
 * `.claude/settings.local.json`, because copying a permission allowlist
 * widens what a `fullAccess: false` launch can do.
 */
const FILES: readonly string[] = [
  // The `.local` override convention (Next.js, Vite, CRA). Spelled out
  // rather than globbed — there is no fourth conventional variant.
  ".env",
  ".env.local",
  ".env.development.local",
  ".env.production.local",
  ".env.test.local",
  // Cloudflare Wrangler.
  ".dev.vars",
  // Registry auth — copied before the deps install so private-registry
  // installs work.
  ".npmrc",
  // Azure Functions.
  "local.settings.json",
  // Terraform's auto-loaded files. `*.auto.tfvars` is absent because its
  // prefix is arbitrary, so covering it would mean globbing.
  "terraform.tfvars",
  "terraform.tfvars.json",
];

/**
 * A directory component or a `*` would be expanded by bash and looked up
 * literally by `fs` — the drift this module exists to prevent. A
 * violation is a bug in the list above, so it throws at definition.
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

export type LocalConfigCopyResult = {
  copied: string[];
  /** Names deliberately not copied, with the reason, so callers can say so. */
  skipped: Array<{ name: string; reason: "symlink" | "not-ignored" }>;
};

/**
 * Which of `names` git would ignore in `dir`. `null` means "couldn't
 * tell" — not a git repo, no git, a timeout — in which case the caller
 * must not filter, leaving behaviour as it was.
 *
 * Exit 1 is check-ignore's "none matched", not a failure.
 */
async function ignoredNames(
  dir: string,
  names: readonly string[]
): Promise<Set<string> | null> {
  const result = await runCommand(
    "git",
    ["-C", dir, "check-ignore", "--", ...names],
    { allowedExitCodes: [0, 1], timeoutMs: 10_000 }
  ).catch(() => null);
  if (!result) return null;
  return new Set(
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  );
}

/**
 * Copy the listed files that exist in `sourceRoot` into `worktreePath`.
 * Best-effort: a missing source is a no-op and a failure is skipped,
 * since a worktree missing one is still usable.
 *
 * Only names git actually ignores *in the worktree* are copied. The list
 * documents that rule, but assuming it is not enough: a copied file that
 * isn't ignored shows up in `git status --porcelain`, and Dispatch reads
 * that everywhere — an auto-cleanup archive preserves the worktree
 * instead of removing it, the agent reads dirty before it has done
 * anything, the file is rendered into the agent diff (so an `.npmrc`
 * would show its token), and `git worktree remove` refuses without
 * `--force`. The check is against the worktree rather than the source
 * because that is where dirtiness is judged, and the two can be on
 * branches with different `.gitignore`s.
 *
 * An existing destination is never overwritten — a fresh worktree holds
 * exactly the tracked files, so a name already there is one the repo
 * commits, and the checked-out revision beats the source checkout's
 * possibly-dirty copy.
 *
 * A checkout is data and a repo may be untrusted, so nothing is checked
 * by path and then acted on by path: a symlink swapped into that window
 * turns every name into a read primitive (`.env -> ~/.ssh/id_rsa`) or a
 * write primitive escaping the worktree. Hence `O_NOFOLLOW` on the
 * source, `O_CREAT | O_EXCL` on the destination, and every subsequent
 * operation on the resulting descriptor.
 *
 * `tmux/setup-script.ts` mirrors this in bash, with one gap it documents:
 * a shell has no no-follow open.
 */
export async function copyLocalConfigFiles(
  sourceRoot: string,
  worktreePath: string
): Promise<LocalConfigCopyResult> {
  const ignored = await ignoredNames(worktreePath, WORKTREE_LOCAL_CONFIG_FILES);
  const copied: string[] = [];
  const skipped: LocalConfigCopyResult["skipped"] = [];

  for (const name of WORKTREE_LOCAL_CONFIG_FILES) {
    const sourceHandle = await open(
      path.join(sourceRoot, name),
      constants.O_RDONLY | constants.O_NOFOLLOW
    ).catch((error: NodeJS.ErrnoException) => {
      // ELOOP means the name exists but is a symlink, which is refused
      // rather than absent — worth telling the user, since otherwise the
      // symptom is the confusing missing-config failure this module fixes.
      if (error?.code === "ELOOP") skipped.push({ name, reason: "symlink" });
      return null;
    });
    if (!sourceHandle) continue;

    const destination = path.join(worktreePath, name);
    try {
      const stats = await sourceHandle.stat();
      if (!stats.isFile()) continue;
      if (ignored && !ignored.has(name)) {
        // `check-ignore` is index-aware and never reports a *tracked* path
        // as ignored, so a repo that commits one of these lands here. That
        // file is already in the worktree from the checkout, which is the
        // right outcome — report only when it genuinely isn't there. This
        // `lstat` decides wording, never whether to write: the copy itself
        // is still settled by the exclusive create below.
        const present = await lstat(destination).catch(() => null);
        if (!present) skipped.push({ name, reason: "not-ignored" });
        continue;
      }
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

  return { copied, skipped };
}
