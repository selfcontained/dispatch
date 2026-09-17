import { useEffect, useRef, useState } from "react";
import { harnessEngineOf } from "@dispatch/shared";

import {
  ProviderIcon,
  providerOf,
} from "@/components/app/harness/provider-icon";
import type { Agent } from "@/components/app/types";
import { Progress } from "@/components/ui/progress";
import { useIconColor } from "@/hooks/use-icon-color";
import { cn } from "@/lib/utils";

/**
 * A startup stage occupies a span rather than a point. `from` is claimed the
 * moment the stage is observed; the bar then creeps toward `to` on a decaying
 * curve and never arrives, so the next stage always has room to land above it.
 * `tau` is roughly how long that stage usually takes — `deps` is the long one
 * because it is a pnpm install.
 */
export type StartupStage = {
  key: string;
  label: string;
  from: number;
  to: number;
  tau: number;
};

export function agentStartupStage(agent: Agent | null): StartupStage | null {
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
      return {
        key: stage,
        label: "Creating your workspace",
        from: 12,
        to: 26,
        tau: 9,
      };
    case "env":
      return {
        key: stage,
        label: "Preparing the environment",
        from: 26,
        to: 40,
        tau: 7,
      };
    case "deps":
      return {
        key: stage,
        label: "Installing dependencies",
        from: 40,
        to: 72,
        tau: 40,
      };
    case "session":
    case "prepare":
      return {
        key: stage,
        label: "Preparing agent session",
        from: 72,
        to: 84,
        tau: 9,
      };
    case "connect":
      return {
        key: stage,
        label: `Connecting to ${provider}`,
        from: 84,
        to: 94,
        tau: 10,
      };
    case "configure":
      return {
        key: stage,
        label: "Applying session settings",
        from: 94,
        to: 99,
        tau: 4,
      };
    default:
      return {
        key: "prepare-workspace",
        label: "Preparing your workspace",
        from: 3,
        to: 12,
        tau: 6,
      };
  }
}

const TICK_MS = 250;

/**
 * The creeping value for a stage, clamped so it can only ever rise. Without
 * the ratchet a stage arriving late would snap the bar backwards to its floor.
 */
function useCreepingProgress(
  stage: StartupStage | null,
  agentId: string
): number {
  const [value, setValue] = useState(stage?.from ?? 0);
  const floor = useRef(0);

  useEffect(() => {
    floor.current = 0;
    setValue(0);
  }, [agentId]);

  const { from, to, tau } = stage ?? { from: 0, to: 0, tau: 1 };
  const key = stage?.key;
  useEffect(() => {
    if (!key) return;
    const startedAt = Date.now();
    const advance = () => {
      const elapsed = (Date.now() - startedAt) / 1000;
      const eased = from + (to - from) * (1 - Math.exp(-elapsed / tau));
      floor.current = Math.max(floor.current, eased);
      setValue(floor.current);
    };
    advance();
    const timer = window.setInterval(advance, TICK_MS);
    return () => window.clearInterval(timer);
  }, [key, from, to, tau]);

  return value;
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
  const progress = useCreepingProgress(stage, agent.id);
  const [takingLonger, setTakingLonger] = useState(false);
  useEffect(() => {
    setTakingLonger(false);
    if (!stageKey) return;
    const timer = window.setTimeout(() => setTakingLonger(true), 30_000);
    return () => window.clearTimeout(timer);
  }, [agent.id, stageKey]);
  if (!stage) return null;

  // Floored, not rounded: the curve only approaches the ceiling, and rounding
  // would let the displayed number sit on the next stage's floor.
  const shown = Math.floor(progress);

  return (
    <section
      data-testid="chat-agent-startup"
      aria-label="Agent startup"
      className={cn(
        "mx-auto flex w-full max-w-md flex-col items-center px-6 text-center",
        compact ? "py-6" : "min-h-[min(50vh,380px)] justify-center py-10"
      )}
    >
      <StartupMark model={agent.model} />
      <h2 className="text-base font-medium text-foreground">
        Getting your agent ready
      </h2>
      <div role="status" className="mt-2 text-sm text-muted-foreground">
        {stage.label}
      </div>
      <Progress
        className="mt-6 bg-primary/10"
        value={shown}
        aria-label="Estimated startup progress"
        aria-valuetext={`Approximately ${shown}% · ${stage.label}`}
      />
      <div className="mt-2 flex w-full justify-between text-[11px] text-muted-foreground">
        <span>Estimated progress</span>
        <span>~{shown}%</span>
      </div>
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        {takingLonger
          ? "This step is taking a little longer. Progress will update when it finishes."
          : "Chat will be ready shortly. Any opening message will be sent automatically."}
      </p>
    </section>
  );
}

/**
 * The provider whose CLI is being started, so the wait is branded as the thing
 * it is waiting on. Falls back to the Dispatch mark when the model names no
 * provider we carry an icon for.
 */
function StartupMark({ model }: { model: string | null | undefined }) {
  return (
    <div
      aria-hidden="true"
      data-testid="chat-agent-startup-mark"
      className="relative mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/20 bg-primary/5 text-primary"
    >
      <div className="absolute inset-0 rounded-2xl bg-primary/10 motion-safe:animate-pulse" />
      {providerOf(model) ? (
        <ProviderIcon provider={model} className="relative h-6 w-6" />
      ) : (
        <DispatchMark />
      )}
    </div>
  );
}

/** Kept a component of its own so the themed-icon query only runs as a fallback. */
function DispatchMark() {
  const { iconColor } = useIconColor();
  return (
    <img
      src={`/icons/${iconColor}/harness-icon.svg`}
      alt=""
      className="relative h-6 w-6 object-contain"
    />
  );
}
