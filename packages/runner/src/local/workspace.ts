import { join } from "node:path";
import {
  RunnerCallError,
  sessionToWire,
} from "@dispatch/runner-protocol/contract";
import { readReceipt } from "../core/workspace.js";
import type { CallHandlers } from "../handlers.js";
import type { LocalSessionOptions } from "./sessions.js";

/** Folder sessions keep their checkout; repository sessions own a managed one. */
export function repositoryWorkspaceDisposer(
  root: string,
  workspace: CallHandlers
): NonNullable<LocalSessionOptions["discardWorkspace"]> {
  return async (session, context) => {
    const receipt = await readReceipt(join(root, sessionToWire(session)));
    if (!receipt?.repository) return;
    const release = workspace["workspace.release"];
    if (!release)
      throw new RunnerCallError({
        code: "unavailable",
        message: "Workspace release is unavailable.",
      });
    const result = await release(
      {
        session,
        deleteBranch: receipt.request.create,
        originalBranch:
          receipt.worktree?.branch ?? receipt.pending?.branch ?? null,
      },
      context
    );
    if (!result.removed)
      throw new RunnerCallError({
        code: "busy",
        message: "The repository checkout is still in use.",
      });
  };
}
