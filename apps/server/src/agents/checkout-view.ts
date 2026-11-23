import {
  isCheckoutView,
  MAX_CHECKOUT_VIEW_BYTES,
  type CheckoutStatsOutcome,
  type CheckoutView,
} from "@dispatch/runner-protocol";
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
      if (!computation.stats) return null;
      const outcome: CheckoutStatsOutcome = computation.kind;
      return { ...computation.stats, outcome };
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

/** A view query on stdin, its data on stdout: the Linux runner's worker. */
export async function runCheckoutViewCli(cwd: string, managed: boolean) {
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const bytes of process.stdin) {
      const buf = Buffer.from(bytes);
      if ((size += buf.length) > 16 * 1024) throw new Error("Query too large");
      chunks.push(buf);
    }
    const view: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (!isCheckoutView(view)) throw new Error("Invalid checkout view");
    const output = JSON.stringify({
      data: await readCheckoutView(cwd, view, managed),
    });
    if (Buffer.byteLength(output) + 1 > MAX_CHECKOUT_VIEW_BYTES)
      throw new WorkspaceError("Checkout response is too large.", 413);
    process.stdout.write(output + "\n");
  } catch (error) {
    if (error instanceof WorkspaceError)
      process.stdout.write(
        JSON.stringify({ status: error.status, error: error.message }) + "\n"
      );
    else {
      process.stderr.write("Unable to read the session checkout.\n");
      process.exitCode = 1;
    }
  }
}
