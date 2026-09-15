import { useEffect, useState } from "react";
import { LoaderCircle, Sparkles } from "lucide-react";
import { harnessEngineOf } from "@dispatch/shared";

import type { Agent } from "@/components/app/types";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

export function agentStartupStage(agent: Agent | null) {
  if (!agent || agent.type !== "dispatch") return null;
  const event = agent.latestEvent;
  const connecting =
    agent.status === "running" &&
    event?.type === "working" &&
    event.metadata?.source === "system" &&
    event.metadata.phase === "agent_start";
  if (agent.status !== "creating" && !connecting) return null;

  const stage = connecting ? event.metadata?.stage : agent.setupPhase;
  const provider = harnessEngineOf(agent.model)?.label ?? "your provider";
  switch (stage) {
    case "worktree":
      return { key: stage, label: "Creating your workspace", progress: 15 };
    case "env":
      return { key: stage, label: "Preparing the environment", progress: 30 };
    case "deps":
      return { key: stage, label: "Installing dependencies", progress: 45 };
    case "session":
    case "prepare":
      return { key: stage, label: "Preparing agent session", progress: 65 };
    case "connect":
      return { key: stage, label: `Connecting to ${provider}`, progress: 80 };
    case "configure":
      return { key: stage, label: "Applying session settings", progress: 95 };
    default:
      return {
        key: "prepare-workspace",
        label: "Preparing your workspace",
        progress: 5,
      };
  }
}

export function AgentStartup({
  agent,
  compact = false,
}: {
  agent: Agent;
  compact?: boolean;
}) {
  const stage = agentStartupStage(agent);
  const stageKey = stage?.key;
  const [takingLonger, setTakingLonger] = useState(false);
  useEffect(() => {
    setTakingLonger(false);
    if (!stageKey) return;
    const timer = window.setTimeout(() => setTakingLonger(true), 30_000);
    return () => window.clearTimeout(timer);
  }, [agent.id, stageKey]);
  if (!stage) return null;

  return (
    <section
      data-testid="chat-agent-startup"
      aria-label="Agent startup"
      className={cn(
        "mx-auto flex w-full max-w-md flex-col items-center px-6 text-center",
        compact ? "py-6" : "min-h-[min(50vh,380px)] justify-center py-10"
      )}
    >
      <div
        aria-hidden="true"
        className="relative mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/20 bg-primary/5 text-primary"
      >
        <div className="absolute inset-0 rounded-2xl bg-primary/10 motion-safe:animate-pulse" />
        <Sparkles className="relative h-6 w-6" />
      </div>
      <h2 className="text-base font-medium text-foreground">
        Getting your agent ready
      </h2>
      <div
        role="status"
        className="mt-2 flex items-center gap-2 text-sm text-muted-foreground"
      >
        <LoaderCircle
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 motion-safe:animate-spin"
        />
        <span>{stage.label}</span>
      </div>
      <Progress
        className="mt-6 bg-primary/10"
        value={stage.progress}
        aria-label="Estimated startup progress"
        aria-valuetext={`Approximately ${stage.progress}% · ${stage.label}`}
      />
      <div className="mt-2 flex w-full justify-between text-[11px] text-muted-foreground">
        <span>Estimated progress</span>
        <span>~{stage.progress}%</span>
      </div>
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        {takingLonger
          ? "This step is taking a little longer. Progress will update when it finishes."
          : "Chat will be ready shortly. Any opening message will be sent automatically."}
      </p>
    </section>
  );
}
