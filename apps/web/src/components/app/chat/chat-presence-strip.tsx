import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import type { ChatFeedEntry } from "@dispatch/shared";

import { describeAgentStatus } from "@/components/app/agent-event-utils";
import { type Agent } from "@/components/app/types";
import {
  type AgentToolBlip,
  type TerminalOutputActivity,
  agentToolBlipAtomFamily,
  terminalOutputActivityAtomFamily,
} from "@/lib/store";
import { cn } from "@/lib/utils";

/** A stable identity, so the default prop cannot retrigger the stamp effect. */
const EMPTY_ENTRIES: readonly ChatFeedEntry[] = [];

/** Output this recent means the agent is visibly doing something. */
export const OUTPUT_ACTIVE_MS = 3_000;
/** No output for this long while "working" reads as a stall worth naming. */
export const QUIET_AFTER_MS = 60_000;
/** How long a tool invocation overlays the phase text. */
export const TOOL_BLIP_MS = 4_000;

const TOOL_BLIP_LABELS: Readonly<Record<string, string>> = {
  dispatch_share_file: "sharing a file",
  dispatch_pin: "pinning",
  dispatch_pins: "pinning",
  dispatch_chat_post: "posting to chat",
  dispatch_chat_update: "posting to chat",
  dispatch_chat_react: "reacting in chat",
  dispatch_launch_agent: "launching an agent",
  dispatch_launch_persona: "launching an agent",
  brain_store_object: "saving notes",
  brain_append_event: "saving notes",
  brain_list_push: "saving notes",
  brain_list_set: "saving notes",
};

/** "sharing a file" for the known tools; "surface update" for the rest. */
export function toolBlipLabel(tool: string): string {
  const known = TOOL_BLIP_LABELS[tool];
  if (known) return known;
  return tool
    .replace(/^(dispatch|repo)_/, "")
    .replace(/_/g, " ")
    .trim();
}

export type PresenceState = {
  /** "Working", "Waiting", "Stopped"… the same words the agent card uses. */
  label: string;
  colorClass: string;
  /** What sits after the label: the phase, a tool blip, or a stall. */
  detail:
    | { kind: "phase"; text: string | null }
    | { kind: "active"; text: string | null }
    | { kind: "tool"; text: string }
    | { kind: "quiet"; minutes: number };
};

/**
 * The newest turn's `updatedAt`, settled or not, or null when the feed holds
 * no turn. Settled counts: settling is the last thing the agent did.
 */
export function latestTurnUpdatedAt(
  entries: readonly ChatFeedEntry[]
): string | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.type === "turn") return entry.updatedAt;
  }
  return null;
}

/**
 * Only observed signals: the latest status event, whether terminal output
 * has flowed recently, and the last tool call the server saw. Nothing here
 * reads pane text.
 *
 * `feedActivityAt` is the second liveness signal, and a dispatch agent needs
 * it: its engine speaks ACP and writes to the feed, so its tmux pane falls
 * silent after the shell's first bytes and terminal output says nothing about
 * whether the agent is alive. Without it a streaming harness agent reads as
 * "quiet for Nm". A local-clock stamp, not a server one, for the reason the
 * tool blip carries one.
 */
export function presenceState(
  agent: Pick<Agent, "status" | "latestEvent">,
  activity: TerminalOutputActivity,
  blip: AgentToolBlip | null,
  now: number,
  feedActivityAt = 0
): PresenceState {
  const running = agent.status === "running";
  const { label, colorClass } = describeAgentStatus(agent, !running);
  if (!running)
    return { label, colorClass, detail: { kind: "phase", text: null } };

  const eventType = agent.latestEvent?.type ?? null;
  const message = agent.latestEvent?.message?.trim() || null;

  if (blip && now - blip.at < TOOL_BLIP_MS) {
    return {
      label,
      colorClass,
      detail: { kind: "tool", text: toolBlipLabel(blip.tool) },
    };
  }

  if (eventType === "waiting_user" || eventType === "blocked") {
    return { label, colorClass, detail: { kind: "phase", text: message } };
  }

  const working = eventType === "working" || eventType === null;
  // Whichever signal is newer: a CLI agent works in the pane, a dispatch
  // agent works in the feed, and either one means it is alive.
  const lastActiveAt = Math.max(activity.lastOutputAt, feedActivityAt);
  const seenActivity = lastActiveAt > 0;
  const sinceActive = now - lastActiveAt;
  if (working && seenActivity && sinceActive <= OUTPUT_ACTIVE_MS) {
    return { label, colorClass, detail: { kind: "active", text: message } };
  }
  if (working && seenActivity && sinceActive >= QUIET_AFTER_MS) {
    return {
      label,
      colorClass,
      detail: {
        kind: "quiet",
        minutes: Math.max(1, Math.floor(sinceActive / 60_000)),
      },
    };
  }
  return { label, colorClass, detail: { kind: "phase", text: message } };
}

/**
 * Time of the last change to the feed's newest turn, which is what a dispatch
 * agent's liveness actually looks like. Holds its last value once the turn
 * stops changing, so a stall is counted from real activity.
 *
 * A change seen while mounted is stamped on the local clock, so a skew
 * between server and browser cannot make a working agent read as stalled —
 * the same reason `AgentToolBlip` carries a local time. The first sighting is
 * the exception: it takes the row's own time, because a turn that stopped
 * before the pane was opened would otherwise reset its stall to zero and
 * hide however long it had really been quiet. That reading is clamped to now,
 * so a server running ahead degrades to the local-clock behaviour rather than
 * reporting activity in the future.
 */
function useFeedActivityAt(
  agentId: string | null,
  entries: readonly ChatFeedEntry[]
): number {
  const stamp = latestTurnUpdatedAt(entries);
  const seen = useRef<string | null>(null);
  const [at, setAt] = useState(0);
  useEffect(() => {
    seen.current = null;
    setAt(0);
  }, [agentId]);
  useEffect(() => {
    if (stamp === null) return;
    const first = seen.current === null;
    seen.current = stamp;
    const parsed = Date.parse(stamp);
    setAt(
      first && Number.isFinite(parsed)
        ? Math.min(parsed, Date.now())
        : Date.now()
    );
  }, [stamp]);
  return at;
}

/** Re-renders on an interval while `enabled`, for the time-based states. */
function useNow(enabled: boolean, intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const handle = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(handle);
  }, [enabled, intervalMs]);
  return now;
}

function ActivityDots({ className }: { className?: string }): JSX.Element {
  return (
    <span
      className={cn("inline-flex items-center gap-0.5", className)}
      aria-hidden="true"
      data-testid="chat-presence-dots"
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1 w-1 rounded-full bg-current animate-pulse"
          style={{ animationDelay: `${i * 200}ms`, animationDuration: "900ms" }}
        />
      ))}
    </span>
  );
}

/**
 * The line above the composer: what the agent is doing right now, from the
 * signals the app actually observes. Replaces the static presence line.
 */
export function ChatPresenceStrip({
  agentId,
  agent,
  entries = EMPTY_ENTRIES,
}: {
  agentId: string | null;
  agent: Agent | null;
  entries?: readonly ChatFeedEntry[];
}): JSX.Element | null {
  const activity = useAtomValue(
    terminalOutputActivityAtomFamily(agentId ?? "")
  );
  const blip = useAtomValue(agentToolBlipAtomFamily(agentId ?? ""));
  const feedActivityAt = useFeedActivityAt(agentId, entries);
  const now = useNow(!!agent && agent.status === "running");
  if (!agent) return null;
  const state = presenceState(agent, activity, blip, now, feedActivityAt);
  const { detail } = state;

  return (
    <div
      className="flex min-w-0 items-center gap-1.5 px-1 text-[11px] text-muted-foreground"
      data-testid="chat-presence"
      data-presence={detail.kind}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full bg-current",
          state.colorClass
        )}
      />
      <span className={cn("shrink-0 font-medium", state.colorClass)}>
        {state.label}
      </span>
      {detail.kind === "tool" ? (
        <>
          <span className="shrink-0">·</span>
          <span
            className="truncate text-foreground/80"
            data-testid="chat-presence-tool"
          >
            {detail.text}
          </span>
        </>
      ) : detail.kind === "quiet" ? (
        <>
          <span className="shrink-0">·</span>
          <span className="truncate" data-testid="chat-presence-quiet">
            quiet for {detail.minutes}m
          </span>
        </>
      ) : detail.kind === "active" ? (
        <>
          <ActivityDots className={state.colorClass} />
          {detail.text ? <span className="truncate">{detail.text}</span> : null}
        </>
      ) : detail.text ? (
        <>
          <span className="shrink-0">·</span>
          <span className="truncate">{detail.text}</span>
        </>
      ) : null}
    </div>
  );
}
