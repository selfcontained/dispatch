import type { TemplateRecord } from "./store.js";

export type TemplateWorktreeSource = Pick<
  TemplateRecord,
  "useWorktree" | "baseBranch" | "branchName"
>;

export type TemplateWorktreeConfig = {
  useWorktree: boolean;
  baseBranch: string | undefined;
  worktreeBranch: string | undefined;
};

/**
 * The single definition of which stored worktree columns feed which
 * `createAgent` inputs. Every path that turns a template (or a job row, which
 * carries the same three columns) into an agent goes through here, so a new
 * worktree column gets wired in one place instead of three. Callers layer
 * their own overrides on top — this only supplies the stored values.
 */
export function templateWorktreeConfig(
  source: TemplateWorktreeSource | null | undefined
): TemplateWorktreeConfig {
  return {
    useWorktree: source?.useWorktree ?? false,
    baseBranch: source?.baseBranch ?? undefined,
    worktreeBranch: source?.branchName ?? undefined,
  };
}
