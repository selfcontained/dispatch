import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";

import { describeAgentStatus } from "@/components/app/agent-event-utils";
import { type Agent } from "@/components/app/types";
import { type AgentToolBlip, agentToolBlipAtomFamily } from "@/lib/store";
import { cn } from "@/lib/utils";

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
    | { kind: "tool"; text: string };
};

/**
 * Only observed signals: the latest status event and the last tool call the
 * server saw.
 */
export function presenceState(
  agent: Pick<Agent, "status" | "latestEvent">,
  blip: AgentToolBlip | null,
  now: number
): PresenceState {
  const running = agent.status === "running";
  const { label, colorClass } = describeAgentStatus(agent, !running);
  if (!running)
    return { label, colorClass, detail: { kind: "phase", text: null } };

  const message = agent.latestEvent?.message?.trim() || null;

  if (blip && now - blip.at < TOOL_BLIP_MS) {
    return {
      label,
      colorClass,
      detail: { kind: "tool", text: toolBlipLabel(blip.tool) },
    };
  }

  return { label, colorClass, detail: { kind: "phase", text: message } };
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

/**
 * The line above the composer: what the agent is doing right now, from the
 * signals the app actually observes. Replaces the static presence line.
 */
export function ChatPresenceStrip({
  agentId,
  agent,
}: {
  agentId: string | null;
  agent: Agent | null;
}): JSX.Element | null {
  const blip = useAtomValue(agentToolBlipAtomFamily(agentId ?? ""));
  const now = useNow(!!agent && agent.status === "running");
  if (!agent) return null;
  const state = presenceState(agent, blip, now);
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
      ) : detail.text ? (
        <>
          <span className="shrink-0">·</span>
          <span className="truncate">{detail.text}</span>
        </>
      ) : null}
    </div>
  );
}
