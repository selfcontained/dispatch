import {
  pathFromWire,
  samePlacement,
  sessionFromWire,
  type Placement,
  RunnerCallError,
  type Runner,
  type Target,
} from "@dispatch/runner-protocol/contract";
import { controllerPlacement } from "../runners/placement.js";
import { detectIconFrom, type IconSource } from "../shared/icon-scan.js";

type IconAgent = { id: string; placement: Placement };

/**
 * The directory main reads an agent's icon from: where it was launched, else
 * its repository root, else its folder. A local folder is read by path; a
 * runner's checkout is the session's launch checkout.
 */
export function iconTarget(agent: IconAgent, baseDir: string): Target {
  return samePlacement(agent.placement, controllerPlacement)
    ? { path: pathFromWire(baseDir) }
    : { session: sessionFromWire(agent.id), checkout: "launch" };
}

/** An agent's checkout as the runner holds it: what the icon scan reads. */
function runnerSource(runner: Runner, target: Target): IconSource {
  return {
    async isFile(rel) {
      try {
        // Nothing is read: a file over zero bytes refuses with `too_large`.
        const file = await runner.call("checkout.read", {
          target,
          path: rel,
          encoding: "base64",
          maxBytes: 0,
        });
        return file !== null;
      } catch (error) {
        // A file over zero bytes refuses, and a link out of the checkout is
        // a file that is there: both are icons the scan finds.
        return (
          error instanceof RunnerCallError &&
          (error.code === "too_large" || error.code === "forbidden")
        );
      }
    },
    async list(rel) {
      try {
        const listing = await runner.call("checkout.list", {
          target,
          path: rel.split("\\").join("/"),
          unfiltered: true,
        });
        // A truncated listing is as large as one the scan refuses.
        return listing.truncated
          ? Array.from({ length: 201 }, () => ({
              name: "",
              kind: "other" as const,
            }))
          : listing.entries;
      } catch {
        return null;
      }
    },
  };
}

/** The icon file in the agent's checkout, relative to it, or null. */
export async function detectAgentIcon(
  runner: Runner,
  target: Target
): Promise<string | null> {
  try {
    return await detectIconFrom(runnerSource(runner, target));
  } catch {
    return null;
  }
}

/** The icon's bytes; "outside" when it is a link out of the checkout. */
export async function readAgentIcon(
  runner: Runner,
  target: Target,
  rel: string
): Promise<Buffer | "outside" | null> {
  try {
    const file = await runner.call("checkout.read", {
      target,
      path: rel.split("\\").join("/"),
      encoding: "base64",
      maxBytes: null,
    });
    return file ? Buffer.from(file.data, "base64") : null;
  } catch (error) {
    return error instanceof RunnerCallError && error.code === "forbidden"
      ? "outside"
      : null;
  }
}
