import { checkoutRunners } from "../runners/directory.js";
import {
  pathFromWire,
  sessionFromWire,
  RunnerCallError,
} from "@dispatch/runner-protocol/contract";
import type { FastifyBaseLogger } from "fastify";

import {
  requestCheckoutCommand,
  type CheckoutCommandRunners,
} from "./checkout-commands.js";
import {
  parseRepoHooks,
  parseRepoToolFile,
  REPO_TOOL_MANIFEST_PATH,
} from "../shared/mcp/repo-tools.js";

import { LifecycleSuperseded } from "./errors.js";
import type { AgentRecord } from "./types.js";

export type LifecycleHookName = "stop" | "archive";

type WhileFenced = <T>(request: () => Promise<T>) => Promise<T>;
const requestNow: WhileFenced = (request) => request();

/** Preview and execution share main's order and retained-worktree fallback. */
export async function* resolveArchiveHooks(
  agent: AgentRecord,
  runners: CheckoutCommandRunners,
  whileFenced: WhileFenced = requestNow
) {
  const { directory, placement } = checkoutRunners(runners, agent);
  if (!directory.for(placement).archive.repositoryHook) return;
  const launch = agent.worktreePath ?? agent.cwd;
  async function read(
    row: AgentRecord,
    checkout: "launch" | "moved",
    root: string
  ) {
    const { directory, placement } = checkoutRunners(runners, row);
    const executor = directory.for(placement);
    const file = await whileFenced(() =>
      executor
        .call("checkout.read", {
          target: {
            session: sessionFromWire(row.id),
            checkout: checkout === "launch" ? "owned" : "moved",
          },
          path: REPO_TOOL_MANIFEST_PATH,
          mode: "native",
          encoding: "utf8",
          maxBytes: null,
          bindRoot: true,
        })
        .catch((error) => {
          // Main treats filesystem errors as an absent manifest. Propagate runner
          // and lifecycle failures, and parse hook definitions outside the catch.
          if (
            error instanceof RunnerCallError &&
            error.code === "failed" &&
            error.details &&
            typeof error.details === "object" &&
            "source" in error.details &&
            error.details.source === "bound-file-read"
          )
            return null;
          throw error;
        })
    );
    const hook = file && parseRepoHooks(parseRepoToolFile(file.data)).archive;
    if (!file || !hook) return null;
    if (!file.rootIdentity)
      throw new Error("Archive manifest read omitted its checkout identity.");
    return { executor, root, checkout, identity: file.rootIdentity, hook };
  }
  const first = await read(agent, "launch", launch);
  if (first) yield first;
  else if (
    agent.worktreePath &&
    agent.launchCwd &&
    agent.launchCwd !== launch &&
    agent.launchCwd !== agent.workspacePath
  ) {
    const root = agent.launchCwd;
    const fallback = await read(
      { ...agent, worktreePath: root },
      "launch",
      root
    );
    if (fallback) yield fallback;
  }
  if (agent.workspacePath && agent.workspacePath !== launch) {
    const moved = await read(agent, "moved", agent.workspacePath);
    if (moved) yield moved;
  }
}

/** Stop is best-effort. Archive propagates failures so cleanup can be retried. */
export async function runLifecycleHook(
  hookName: LifecycleHookName,
  agent: AgentRecord,
  logger: FastifyBaseLogger,
  runners: CheckoutCommandRunners,
  whileFenced: WhileFenced = requestNow
): Promise<void> {
  if (hookName === "archive") {
    for await (const {
      executor,
      root,
      checkout,
      identity,
      hook,
    } of resolveArchiveHooks(agent, runners, whileFenced)) {
      logger.info(
        {
          agentId: agent.id,
          hook: hookName,
          command: hook.command,
          repoRoot: root,
        },
        "Running lifecycle hook"
      );
      const [command, ...args] = hook.command;
      const result = await whileFenced(() =>
        executor.call("checkout.exec", {
          target: { session: sessionFromWire(agent.id), checkout },
          guard: { root: pathFromWire(root), identity },
          argv: hook.command,
          env: { DISPATCH_AGENT_ID: agent.id },
          timeoutMs: 60_000,
          maxOutput: null,
          shell: "direct",
        })
      ).catch((error) => {
        if (error instanceof RunnerCallError && error.code === "timeout")
          throw new Error(
            `Command timed out (${command} ${args.join(" ")}), timeoutMs=60000`
          );
        throw error;
      });
      if (result.exitCode !== 0)
        throw new Error(
          `Command failed (${command} ${args.join(" ")}), exitCode=${result.exitCode}, stderr=${result.stderr.trim()}`
        );
      const output = result.stdout.trim();
      if (output)
        logger.info(
          { agentId: agent.id, repoRoot: root, output },
          "Archive hook completed"
        );
    }
    return;
  }
  const { directory, placement } = checkoutRunners(runners, agent);
  const includeArchive = directory.for(placement).archive.repositoryHook;
  for (const checkout of ["launch", "moved"] as const) {
    try {
      const target = { checkout, path: REPO_TOOL_MANIFEST_PATH };
      const file = await whileFenced(() =>
        requestCheckoutCommand(runners, agent, { ...target, kind: "read" })
      );
      const hook =
        file &&
        parseRepoHooks(parseRepoToolFile(file.content), includeArchive)[
          hookName
        ];
      if (!hook) continue;
      logger.info(
        { agentId: agent.id, hook: hookName, checkout },
        "Running lifecycle hook"
      );
      const result = await whileFenced(() =>
        requestCheckoutCommand(runners, agent, {
          ...target,
          kind: "run",
          state: file.state,
          argv: hook.command,
        })
      );
      if (result.exitCode !== 0) {
        logger.warn(
          {
            agentId: agent.id,
            hook: hookName,
            checkout,
            exitCode: result.exitCode,
            stderr: result.stderr,
            truncated: result.truncated,
          },
          "Lifecycle hook exited with non-zero code"
        );
      }
    } catch (err) {
      if (err instanceof LifecycleSuperseded) throw err;
      logger.warn(
        { err, agentId: agent.id, hook: hookName, checkout },
        "Runner lifecycle hook failed; continuing shutdown"
      );
    }
  }
}
