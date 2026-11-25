import type { WorkspaceTargetAgent } from "../agents/workspace-target.js";
import {
  displayPath,
  sessionFromWire,
  type Placement,
} from "@dispatch/runner-protocol/contract";
import {
  runnerDirectory,
  type CheckoutCommandRunners,
} from "../runners/directory.js";
import { checkoutReadPlacement } from "../runners/placement.js";
import { identityKey } from "../runners/repository-identity.js";

type ScopedAgent = WorkspaceTargetAgent & {
  id: string;
  placement?: Placement;
  projectId?: string | null;
};
export type TaskRootReader = (agent: ScopedAgent) => Promise<string | null>;

/** The current roots on the agent's runner, without branch or icon probes. */
export function runnerTaskRootReader(
  runners: () => CheckoutCommandRunners
): TaskRootReader {
  return async (agent) => {
    const effectiveWorkspace =
      agent.workspacePath ?? agent.worktreePath ?? agent.cwd;
    const cwd = agent.cwd || effectiveWorkspace;
    if (!cwd) return null;
    const placement = agent.placement ?? checkoutReadPlacement(agent.cwd);
    const selected = {
      ...agent,
      cwd,
      workspacePath: agent.workspacePath ?? null,
      placement,
    };
    const roots = await runnerDirectory(runners(), selected)
      .for(placement)
      .call("git.roots", { target: { session: sessionFromWire(agent.id) } });
    return roots.repositoryRoot === null
      ? null
      : displayPath(roots.repositoryRoot);
  };
}

type ProjectForAgent = (input: {
  projectId?: string | null;
  paths: Array<string | null | undefined>;
}) => Promise<string | null>;

/**
 * What places an agent on a task board (`TaskService.projectForAgent`): its
 * project, else the repo its current workspace is in, else that workspace
 * itself. The MCP task tools (whose agent `cwd` is the workspace) and the
 * task conversation both build it here so they agree.
 */
export function taskScopeInput(
  projectId: string | null | undefined,
  workspaceDir: string | null,
  repoRoot: string | null
): { projectId: string | null; paths: Array<string | null> } {
  return { projectId: projectId ?? null, paths: [repoRoot, workspaceDir] };
}

/** The agent's task project, resolved the way its task tools resolve it. */
export async function agentTaskProject(
  agent: ScopedAgent,
  projectForAgent: ProjectForAgent,
  readRepositoryRoot: TaskRootReader
): Promise<string | null> {
  if (agent.projectId) return agent.projectId;
  // Probed live, as the MCP routes do, never from cached git context.
  const placement = agent.placement ?? checkoutReadPlacement(agent.cwd);
  const effectiveWorkspace =
    agent.workspacePath ?? agent.worktreePath ?? agent.cwd;
  const workspaceDir = identityKey(placement, effectiveWorkspace);
  let repoRoot: string | null = null;
  if (effectiveWorkspace) {
    try {
      repoRoot = identityKey(placement, await readRepositoryRoot(agent));
    } catch {}
  }
  return projectForAgent(taskScopeInput(null, workspaceDir, repoRoot));
}
