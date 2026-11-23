/*
 * The one-time binding import's app side: what the agent rows already record
 * about each local session's checkout, sent to the local runner over the
 * launcher pipe. The rows give facts; the runner decides ownership with Git
 * (`packages/runner/src/local/bindings.ts`), and never replaces a binding it
 * already holds, so the same list is sent at every start.
 *
 * The worktree claim reproduces main's archive exactly: main removes
 * `worktree_path` and nothing else (`cleanupAgentWorktree` in main's
 * `agents/archive.ts`), whatever `cwd` or `workspace_path` say. So a row
 * claims a worktree only when `worktree_path` is set; a moved workspace is a
 * current path, never a removable one.
 */
import type { Pool } from "pg";
import { remotePlacement } from "@dispatch/runner-protocol";
import { runnerIdToWire } from "@dispatch/runner-protocol/contract";
import { LOCAL_RUNNER_ID } from "./placement.js";

export type LocalBindingRow = {
  id: string;
  cwd: string | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  baseBranch: string | null;
  workspacePath: string | null;
};

/**
 * One session's checkout facts, structurally the launcher's `LauncherBinding`
 * (only `runners/local.ts` may import the launcher; its option type checks
 * the match).
 */
export type LocalBinding = {
  session: string;
  path: string;
  currentPath: string | null;
  worktree: {
    path: string;
    branch: string | null;
    base: string | null;
  } | null;
};

const text = (value: string | null) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/**
 * One row's binding, or null when the row has no checkout on this machine
 * (no `cwd`, or a runner locator left by an older build).
 */
export function bindingFromRow(row: LocalBindingRow): LocalBinding | null {
  const cwd = text(row.cwd);
  if (!cwd || remotePlacement(cwd)) return null;
  const worktreePath = text(row.worktreePath);
  const workspacePath = text(row.workspacePath);
  return {
    session: row.id,
    path: cwd,
    currentPath: workspacePath && workspacePath !== cwd ? workspacePath : null,
    worktree: worktreePath
      ? {
          path: worktreePath,
          branch: text(row.worktreeBranch),
          base: text(row.baseBranch),
        }
      : null,
  };
}

/**
 * Every live local agent row, archives still in progress included. Deleted
 * rows are done: main already removed or kept their checkout.
 */
export async function readLocalBindings(
  pool: Pick<Pool, "query">
): Promise<LocalBinding[]> {
  const { rows } = await pool.query<LocalBindingRow>(
    `SELECT id, cwd,
            worktree_path AS "worktreePath",
            worktree_branch AS "worktreeBranch",
            base_branch AS "baseBranch",
            workspace_path AS "workspacePath"
       FROM agents
      WHERE deleted_at IS NULL AND runner_id = $1
      ORDER BY created_at, id`,
    [runnerIdToWire(LOCAL_RUNNER_ID)]
  );
  return rows.flatMap((row) => bindingFromRow(row) ?? []);
}
