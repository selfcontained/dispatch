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
  projectForAgent: ProjectForAgent
): Promise<string | null> {
  if (agent.projectId) return agent.projectId;
  // Probed live, as the MCP routes do, never from cached git context.
  const workspaceDir = agentWorkspaceDir(agent) ?? agent.cwd;
  let repoRoot: string | null = null;
  if (workspaceDir) {
    try {
      repoRoot = await resolveRepoRoot(workspaceDir);
    } catch {}
  }
  return projectForAgent(taskScopeInput(null, workspaceDir, repoRoot));
}
