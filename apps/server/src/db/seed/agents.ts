import type { PoolClient } from "pg";

import { seedNow } from "./constants.js";

type AgentStatus =
  | "creating"
  | "running"
  | "stopping"
  | "stopped"
  | "archiving"
  | "error";
type AgentType = "codex" | "claude";
type SetupPhase = "worktree" | "env" | "deps" | "session" | null;
type ArchivePhase =
  | "stopping"
  | "worktree-check"
  | "worktree-cleanup"
  | "finalizing"
  | null;

type SeedAgentInput = {
  id: string;
  name: string;
  type: AgentType;
  status: AgentStatus;
  cwd: string;
  worktreePath?: string | null;
  worktreeBranch?: string | null;
  baseBranch?: string | null;
  setupPhase?: SetupPhase;
  archivePhase?: ArchivePhase;
  lastError?: string | null;
  persona?: string | null;
  parentAgentId?: string | null;
  createdDaysAgo: number;
};

function ago(now: Date, minutes: number): Date {
  return new Date(now.getTime() - minutes * 60 * 1000);
}

export async function seedAgents(client: PoolClient): Promise<void> {
  const now = seedNow();
  const demoCwd = "/tmp/dispatch-demo";

  const agents: SeedAgentInput[] = [
    // Simple agent. Base branch set.
    {
      id: "seed-agent-running-main",
      name: "theme polish",
      type: "codex",
      status: "running",
      cwd: demoCwd,
      baseBranch: "main",
      worktreePath: "/tmp/dispatch-demo/.dispatch/worktrees/seed-theme-polish",
      worktreeBranch: "seed/theme-polish",
      createdDaysAgo: 1,
    },
    // Rich agent — has files. Base branch set.
    {
      id: "seed-agent-running-feature",
      name: "add activity heatmap",
      type: "claude",
      status: "running",
      cwd: demoCwd,
      worktreePath: "/tmp/dispatch-demo/.dispatch/worktrees/seed-feature",
      worktreeBranch: "seed/activity-heatmap",
      baseBranch: "main",
      createdDaysAgo: 2,
    },
  ];

  for (const agent of agents) {
    const created = ago(now, agent.createdDaysAgo * 24 * 60);
    await client.query(
      `
      INSERT INTO agents (
        id, name, type, status, cwd, files_dir, agent_args, full_access,
        setup_phase, archive_phase, last_error,
        persona, parent_agent_id, persona_context,
        worktree_path, worktree_branch, base_branch,
        created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,NULL,'[]'::jsonb,false,
        $6,$7,$8,
        $9,$10,NULL,
        $11,$12,$13,
        $14,$14
      )
      `,
      [
        agent.id,
        agent.name,
        agent.type,
        agent.status,
        agent.cwd,
        agent.setupPhase ?? null,
        agent.archivePhase ?? null,
        agent.lastError ?? null,
        agent.persona ?? null,
        agent.parentAgentId ?? null,
        agent.worktreePath ?? null,
        agent.worktreeBranch ?? null,
        agent.baseBranch ?? null,
        created,
      ]
    );
  }
}
