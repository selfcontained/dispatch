import {
  sessionFromWire,
  RunnerCallError,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import { detectIconFrom, type IconSource } from "../shared/icon-scan.js";

type IconTarget = { id: string };

const target = (agent: IconTarget) =>
  ({
    session: sessionFromWire(agent.id),
    checkout: "launch",
  }) as const;

/** An agent's checkout as the runner holds it: what the icon scan reads. */
function runnerSource(runner: Runner, agent: IconTarget): IconSource {
  return {
    async isFile(rel) {
      try {
        // Nothing is read: a file over zero bytes refuses with `too_large`.
        const file = await runner.call("checkout.read", {
          target: target(agent),
          path: rel,
          encoding: "base64",
          maxBytes: 0,
        });
        return file !== null;
      } catch (error) {
        return error instanceof RunnerCallError && error.code === "too_large";
      }
    },
    async list(rel) {
      try {
        const listing = await runner.call("checkout.list", {
          target: target(agent),
          path: rel.split("\\").join("/"),
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
  agent: IconTarget
): Promise<string | null> {
  try {
    return await detectIconFrom(runnerSource(runner, agent));
  } catch {
    return null;
  }
}

/** The icon's bytes, or null when the runner cannot read them. */
export async function readAgentIcon(
  runner: Runner,
  agent: IconTarget,
  rel: string
): Promise<Buffer | null> {
  try {
    const file = await runner.call("checkout.read", {
      target: target(agent),
      path: rel.split("\\").join("/"),
      encoding: "base64",
      maxBytes: null,
    });
    return file ? Buffer.from(file.data, "base64") : null;
  } catch {
    return null;
  }
}
