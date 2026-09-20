import type { PoolClient } from "pg";

import { seedMetadata, seedNow } from "./constants.js";

type AgentStatus =
  | "creating"
  | "running"
  | "stopping"
  | "stopped"
  | "archiving"
  | "error";
type AgentType = "codex" | "claude";
type LatestEventType = "working" | "blocked" | "waiting_user" | "done" | "idle";
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
  latestEvent?: {
    type: LatestEventType;
    message: string;
    ageMinutes: number;
  } | null;
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
    // Simple agent — no feedback, no reviews. Base branch set.
    {
      id: "seed-agent-running-main",
      name: "theme polish",
      type: "codex",
      status: "running",
      cwd: demoCwd,
      baseBranch: "main",
      worktreePath: "/tmp/dispatch-demo/.dispatch/worktrees/seed-theme-polish",
      worktreeBranch: "seed/theme-polish",
      latestEvent: {
        type: "working",
        message: "Tweaking sidebar spacing",
        ageMinutes: 2,
      },
      createdDaysAgo: 1,
    },
    // Rich agent — has persona review + feedback + media + all 7 pin types. Base branch set.
    {
      id: "seed-agent-running-feature",
      name: "add activity heatmap",
      type: "claude",
      status: "running",
      cwd: demoCwd,
      worktreePath: "/tmp/dispatch-demo/.dispatch/worktrees/seed-feature",
      worktreeBranch: "seed/activity-heatmap",
      baseBranch: "main",
      latestEvent: {
        type: "working",
        message: "Wiring hourly breakdown",
        ageMinutes: 12,
      },
      createdDaysAgo: 2,
    },
  ];

  for (const agent of agents) {
    const created = ago(now, agent.createdDaysAgo * 24 * 60);
    const latestEventUpdatedAt = agent.latestEvent
      ? ago(now, agent.latestEvent.ageMinutes)
      : null;
    await client.query(
      `
      INSERT INTO agents (
        id, name, type, status, cwd, media_dir, agent_args, full_access,
        setup_phase, archive_phase, last_error,
        persona, parent_agent_id, persona_context,
        worktree_path, worktree_branch, base_branch,
        latest_event_type, latest_event_message, latest_event_metadata, latest_event_updated_at,
        created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,NULL,'[]'::jsonb,false,
        $6,$7,$8,
        $9,$10,NULL,
        $11,$12,$13,
        $14,$15,$16::jsonb,$17,
        $18,$18
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
        agent.latestEvent?.type ?? null,
        agent.latestEvent?.message ?? null,
        agent.latestEvent ? seedMetadata() : null,
        latestEventUpdatedAt,
        created,
      ]
    );
  }
}
