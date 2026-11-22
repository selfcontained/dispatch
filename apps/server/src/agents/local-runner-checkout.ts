import { lstat } from "node:fs/promises";
import type {
  CheckoutObservation,
  CheckoutRelease,
  CheckoutReleaseResult,
} from "@dispatch/runner-protocol";
import { cleanupGitWorktree } from "../shared/git/worktree.js";
import { runCommand, type CommandRunner } from "../shared/lib/run-command.js";
import { observeGitCheckout } from "./checkout-inspection.js";

/** Trusted native binding from the host. The selected workspace can move independently. */
type LocalCheckoutBinding = {
  id: string;
  worktreePath: string | null;
  worktreeBranch: string | null;
  baseBranch: string | null;
};

const boundedGit: CommandRunner = (command, args, options) =>
  runCommand(command, args, {
    ...options,
    timeoutMs: options?.timeoutMs ?? 60_000,
  });

export function localCheckoutRelease(
  binding: LocalCheckoutBinding,
  operation: Extract<CheckoutRelease, { kind: "observe" }>
): Promise<CheckoutObservation>;
export function localCheckoutRelease(
  binding: LocalCheckoutBinding,
  operation: Extract<CheckoutRelease, { kind: "release" }>
): Promise<CheckoutReleaseResult>;
export async function localCheckoutRelease(
  binding: LocalCheckoutBinding,
  operation: CheckoutRelease
): Promise<CheckoutObservation | CheckoutReleaseResult> {
  const { id, worktreePath, worktreeBranch, baseBranch } = binding;
  if (operation.kind === "observe") {
    const checkout = worktreePath
      ? await observeGitCheckout(worktreePath).catch(() => null)
      : null;
    return {
      ownership: worktreePath ? "owned" : "external",
      owner: worktreePath ? id : null,
      borrowers: [],
      checkout,
    };
  }

  if (!worktreePath) return "released";
  if (operation.expectedState === null) return "retained";
  const entry = await lstat(worktreePath).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  );
  if (!entry) return "released";
  await cleanupGitWorktree(
    {
      cwd: worktreePath,
      deleteBranch: Boolean(worktreeBranch && worktreeBranch !== baseBranch),
      force: true,
      originalBranch: worktreeBranch,
    },
    boundedGit
  );
  return "released";
}
