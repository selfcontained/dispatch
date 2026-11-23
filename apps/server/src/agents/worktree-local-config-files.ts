/*
 * The copy list: Dispatch's policy for which ignored files a new worktree
 * gets from its source checkout. Sent to the runner as `copyIgnored`; the
 * copy itself is `worktree-local-config.ts`.
 */
/**
 * Gitignored local config copied into a new worktree, because `git
 * worktree add` only materializes tracked files — so a developer's
 * secrets silently go missing and the agent's first command fails oddly.
 * Consumed by both launch paths (`workspace-prep.ts` for inert mode,
 * the workspace step) so they cannot drift apart.
 *
 * Additions must be conventionally gitignored, must be fixed by copying
 * alone, and must not grant the agent new capabilities. The ignore rule
 * carries real weight: a copied file git does *not* ignore shows up in
 * `git status --porcelain`, which makes the agent read dirty, renders it
 * into the agent diff, stops auto-cleanup removing the worktree, and
 * blocks a non-forced `git worktree remove`. `.npmrc` was on this list
 * and came off for exactly that reason — neither npm nor pnpm gitignores
 * it, so it is commonly tracked. Two entries were
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
