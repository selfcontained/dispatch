import type { Agent } from "@/components/app/types";
import {
  sidebarScheduleTime,
  useUpcomingSchedule,
} from "@/components/app/scheduled-messages";
import {
  useAgentTurnLabel,
  useFirstAgentWithTurnLabel,
} from "@/hooks/use-agent-turn-label";
import { useLocalDay } from "@/hooks/use-local-day";

export type AgentActivityTone =
  | "starting"
  | "working"
  | "waiting"
  | "blocked"
  | "idle"
  | "stopped"
  | "archiving";

export type AgentActivityGlyph = "bars" | "turn" | "clock" | "none";

export function agentPhaseStatus(
  agent: Agent
): { label: string; tone: "starting" | "archiving" } | null {
  if (agent.status === "creating" || agent.setupPhase) {
    return { label: "Starting…", tone: "starting" };
  }
  if (agent.status !== "archiving") return null;
  const label =
    agent.archivePhase === "stopping"
      ? "Stopping agent…"
      : agent.archivePhase === "worktree-check"
        ? "Checking worktree…"
        : agent.archivePhase === "worktree-cleanup"
          ? "Removing worktree…"
          : agent.archivePhase === "finalizing"
            ? "Finalizing…"
            : "Archiving…";
  return { label, tone: "archiving" };
}

export function hasPhaseStatus(agent: Agent): boolean {
  return agentPhaseStatus(agent) !== null;
}

export function useAgentActivity(
  agent: Agent,
  childAgents: readonly Agent[] = []
) {
  const phase = agentPhaseStatus(agent);
  const ownStep = useAgentTurnLabel(
    agent.id,
    agent.currentTurn?.blockId ?? null
  );
  const hasOwnActivity = Boolean(
    phase || agent.reconnect || (agent.currentTurn && ownStep)
  );
  const activeChild = useFirstAgentWithTurnLabel(
    hasOwnActivity ? [] : childAgents.filter((child) => child.currentTurn)
  );
  const childStep = useAgentTurnLabel(
    activeChild?.id ?? agent.id,
    activeChild?.currentTurn?.blockId ?? null
  );
  const schedule = useUpcomingSchedule(agent.id);
  const today = useLocalDay();

  if (phase)
    return {
      ...phase,
      glyph: "bars" as const,
      sourceAgent: agent,
      kind: "phase" as const,
    };
  if (agent.reconnect) {
    return {
      label: "Reconnecting",
      tone: "waiting" as const,
      glyph:
        agent.reconnect.phase === "trying"
          ? ("bars" as const)
          : ("clock" as const),
      sourceAgent: agent,
      kind: "reconnect" as const,
    };
  }
  if (agent.currentTurn && ownStep) {
    return {
      label: ownStep,
      tone: "working" as const,
      glyph: "turn" as const,
      sourceAgent: agent,
      kind: "turn" as const,
    };
  }
  if (activeChild && childStep) {
    return {
      label: childStep,
      tone: "working" as const,
      glyph: "turn" as const,
      sourceAgent: activeChild,
      kind: "turn" as const,
    };
  }
  if (schedule) {
    return {
      label: `Next ${sidebarScheduleTime(schedule.nextDueAt, today)}`,
      tone: "idle" as const,
      glyph: "clock" as const,
      sourceAgent: agent,
      kind: "schedule" as const,
    };
  }
  const tone: AgentActivityTone = agent.currentTurn
    ? "working"
    : agent.activity === "starting"
      ? "starting"
      : agent.activity === "working"
        ? "working"
        : agent.activity === "waiting"
          ? "waiting"
          : agent.activity === "blocked"
            ? "blocked"
            : agent.activity === "idle"
              ? "idle"
              : "stopped";
  return {
    label: null,
    tone,
    glyph:
      tone === "working" || tone === "starting"
        ? ("turn" as const)
        : ("none" as const),
    sourceAgent: agent,
    kind: "state" as const,
  };
}
