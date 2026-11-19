import type { CheckoutView } from "@dispatch/runner-protocol";
import { readWorkspaceView, WorkspaceError } from "../files/workspace-view.js";
import { getAgentDiff, getAgentFileDiff } from "../shared/git/agent-diff.js";
import { getAgentDiffImage } from "../shared/git/diff-image.js";
import { getDiffStatsComputation } from "../shared/git/diff-stats.js";
import { recordedReviewBase } from "./checkout-inspection.js";
/** Runs under the workload account on Linux, or in process for a native session. */
export async function readCheckoutView(
  cwd: string,
  view: CheckoutView,
  managed = false
) {
  if (!("baseBranch" in view)) return readWorkspaceView(cwd, view);
  const base =
    view.baseBranch ?? (managed ? await recordedReviewBase(cwd) : null);
  switch (view.kind) {
    case "stats": {
      const computation = await getDiffStatsComputation(cwd, base, view);
      if (computation.kind === "failure")
        throw new Error("Git status unavailable.");
      return computation.stats;
    }
    case "diff":
      return (
        (await getAgentDiff(cwd, base, undefined, view)) ?? {
          baseRef: null,
          files: [],
        }
      );
    case "fileDiff":
      return getAgentFileDiff(cwd, base, view.path, undefined, view);
    case "image": {
      const result = await getAgentDiffImage(
        cwd,
        base,
        view.path,
        view.side,
        view
      );
      if (!result.ok)
        throw new WorkspaceError(
          "Image not available.",
          result.reason === "too-large" ? 413 : 404
        );
      return result.buffer.toString("base64");
    }
  }
}
