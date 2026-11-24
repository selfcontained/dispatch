import {
  pathFromWire,
  sessionFromWire,
  RunnerCallError,
  type Placement,
  type Runner,
  type Target,
} from "@dispatch/runner-protocol/contract";
import {
  runnerDirectory,
  type CheckoutCommandRunners,
} from "../runners/directory.js";
import type { Pool } from "pg";
import type { AgentRecord } from "@dispatch/shared";
import { getDirectoryIconPath } from "../shared/directory-icon-cache.js";
import { detectIconFrom, type IconSource } from "../shared/icon-scan.js";
import { identityKey } from "../runners/repository-identity.js";
import { sessionRunner, type CheckoutReadRunners } from "./checkout-runner.js";

type ReadAgent = Parameters<typeof sessionRunner>[1];

type IconAgent = { id: string };

/**
 * An agent's launch checkout, for every placement: the runner resolves it
 * (a local session's is where main reads its icon: `launchCwd`, else the
 * repository root, else the folder).
 */
export function iconTarget(agent: IconAgent): Target {
  return { session: sessionFromWire(agent.id), checkout: "launch" };
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

/**
 * The icon's bytes; "outside" when it is a link out of the checkout and
 * "unreadable" when the runner may not open it.
 */
export async function readAgentIcon(
  runner: Runner,
  target: Target,
  rel: string
): Promise<Buffer | "outside" | "unreadable" | null> {
  try {
    const file = await runner.call("checkout.read", {
      target,
      path: rel.split("\\").join("/"),
      encoding: "base64",
      maxBytes: null,
    });
    return file ? Buffer.from(file.data, "base64") : null;
  } catch (error) {
    if (!(error instanceof RunnerCallError) || error.code !== "forbidden")
      return null;
    return (error.details as { reason?: unknown } | undefined)?.reason ===
      "unreadable"
      ? "unreadable"
      : "outside";
  }
}

type KeyedAgent = Pick<
  AgentRecord,
  "id" | "placement" | "cwd" | "launchCwd" | "gitContext" | "projectId"
>;

/**
 * The icon cache key for an agent's launch checkout. On the controller's
 * runner it is main's key, byte for byte: the folder the agent was launched
 * in (T34's `identityKey`). On any other runner it is the project's
 * repository URL, shared by that project's agents there, or none (a probe
 * each time). A runner agent never reads or writes a folder's entry, and the
 * two key spaces cannot collide: a key is an absolute path or a URL.
 */
export async function iconCacheKey(
  pool: Pool,
  agent: KeyedAgent
): Promise<string | null> {
  const folder = identityKey(
    agent.placement,
    agent.launchCwd ?? agent.gitContext?.repoRoot ?? agent.cwd
  );
  if (folder !== null || !agent.projectId) return folder;
  const project = await pool.query<{ repository: string | null }>(
    "SELECT repository FROM projects WHERE id = $1",
    [agent.projectId]
  );
  return project.rows[0]?.repository ?? null;
}

/** The icon a runner finds at `target`, cached under `key` (none: a probe each time). */
function cachedIcon(
  pool: Pool,
  key: string | null,
  runner: Runner,
  target: Target
): Promise<string | null> {
  const probe = () => detectAgentIcon(runner, target);
  return key === null ? probe() : getDirectoryIconPath(pool, key, probe);
}

/** The icon in an agent's launch checkout, read on its runner, cached by `iconCacheKey`. */
export async function agentIconPath(
  pool: Pool,
  runners: CheckoutReadRunners,
  agent: KeyedAgent & ReadAgent
): Promise<string | null> {
  return cachedIcon(
    pool,
    await iconCacheKey(pool, agent),
    sessionRunner(runners, agent),
    iconTarget(agent)
  );
}

/**
 * The icon in a launch folder before any session exists, read on the runner
 * it is on, under main's key for it (`identityKey`: the folder itself on the
 * controller's runner, none elsewhere).
 */
export function folderIconPath(
  pool: Pool,
  runners: CheckoutCommandRunners,
  placement: Placement,
  folder: string
): Promise<string | null> {
  return cachedIcon(
    pool,
    identityKey(placement, folder),
    runnerDirectory(runners).for(placement),
    { path: pathFromWire(folder) }
  );
}
