import {
  agentWorkspaceDir,
  type WorkspaceTargetAgent,
} from "../agents/workspace-target.js";
import { resolveRepoRoot } from "../shared/git/git-context.js";

type ScopedAgent = WorkspaceTargetAgent & { projectId?: string | null };

type ProjectForAgent = (input: {
  projectId?: string | null;
  paths: Array<string | null | undefined>;
}) => Promise<string | null>;

/**
 * What places an agent on a task board (`TaskService.projectForAgent`): its
 * project, else the repo its current workspace is in, else its cwd. The task
 * tools and the task conversation build it here so they agree.
 */
export function taskScopeInput(
  agent: { projectId?: string | null; cwd: string | null },
  repoRoot: string | null
): { projectId: string | null; paths: Array<string | null> } {
  return { projectId: agent.projectId ?? null, paths: [repoRoot, agent.cwd] };
}

/** The repo holding the agent's current workspace, probed live. */
export async function workspaceRepoRoot(
  agent: WorkspaceTargetAgent
): Promise<string | null> {
  const dir = agentWorkspaceDir(agent) ?? agent.cwd;
  if (!dir) return null;
  try {
    return await resolveRepoRoot(dir);
  } catch {
    return null;
  }
}

/** The agent's task project, resolved the way its task tools resolve it. */
export async function agentTaskProject(
  agent: ScopedAgent,
  projectForAgent: ProjectForAgent
): Promise<string | null> {
  if (agent.projectId) return agent.projectId;
  return projectForAgent(taskScopeInput(agent, await workspaceRepoRoot(agent)));
}
