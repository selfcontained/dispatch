import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown, Loader2, Square } from "lucide-react";

import type { Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";

type StopRequest = { agentId: string; blockId: string };
type RequestState = { blockId: string; status: "stopping" | "unconfirmed" };

/** The composer has one Stop control for every open turn in the workspace. */
export function StopTurnButton({
  agents,
  selectedAgentId,
  onError,
}: {
  agents: readonly Agent[];
  selectedAgentId: string | null;
  onError: (message: string) => void;
}): JSX.Element {
  const [requests, setRequests] = useState<Record<string, RequestState>>({});
  const timers = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const pendingTimers = timers.current;
    return () => {
      for (const timer of pendingTimers.values()) window.clearTimeout(timer);
    };
  }, []);

  const turns = useMemo(
    () =>
      agents
        .filter((agent) => agent.status === "running" && agent.currentTurn)
        .sort((a, b) =>
          a.id === selectedAgentId ? -1 : b.id === selectedAgentId ? 1 : 0
        ),
    [agents, selectedAgentId]
  );
  const cancel = useMutation<unknown, Error, StopRequest>({
    mutationFn: ({ agentId }) =>
      api(`/api/v1/agents/${encodeURIComponent(agentId)}/runtime/cancel`, {
        method: "POST",
      }),
    onError: (error, { agentId, blockId }) => {
      window.clearTimeout(timers.current.get(agentId));
      timers.current.delete(agentId);
      setRequests((previous) => ({
        ...previous,
        [agentId]: { blockId, status: "unconfirmed" },
      }));
      onError(`Couldn't stop the turn: ${error.message}`);
    },
  });

  function stop(agent: Agent): void {
    const blockId = agent.currentTurn?.blockId;
    if (!blockId) return;
    window.clearTimeout(timers.current.get(agent.id));
    setRequests((previous) => ({
      ...previous,
      [agent.id]: { blockId, status: "stopping" },
    }));
    timers.current.set(
      agent.id,
      window.setTimeout(() => {
        setRequests((previous) => ({
          ...previous,
          [agent.id]: { blockId, status: "unconfirmed" },
        }));
        timers.current.delete(agent.id);
      }, 10_000)
    );
    cancel.mutate({ agentId: agent.id, blockId });
  }

  function stateOf(agent: Agent): RequestState["status"] | null {
    const request = requests[agent.id];
    return request?.blockId === agent.currentTurn?.blockId
      ? request.status
      : null;
  }

  const single = turns.length === 1 ? turns[0] : null;
  const singleState = single ? stateOf(single) : null;
  const label = single
    ? singleState === "stopping"
      ? `Stopping ${single.name}…`
      : singleState === "unconfirmed"
        ? `Stop unconfirmed. Retry for ${single.name}`
        : `Stop ${single.name}'s turn`
    : turns.length
      ? `Choose an agent to stop (${turns.length} active)`
      : "No active turns";
  const button = (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className="h-9 w-9 shrink-0 text-muted-foreground pointer-coarse:min-h-11 pointer-coarse:min-w-11"
      onClick={single ? () => stop(single) : undefined}
      disabled={turns.length === 0 || singleState === "stopping"}
      data-testid="chat-stop-turn"
      title={label}
      aria-label={label}
    >
      {singleState === "stopping" ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <Square className="h-3 w-3 fill-current" aria-hidden="true" />
      )}
      {turns.length > 1 && (
        <ChevronDown className="ml-0.5 h-3 w-3" aria-hidden="true" />
      )}
    </Button>
  );

  if (turns.length <= 1) return button;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="min-w-56">
        {turns.map((agent) => {
          const state = stateOf(agent);
          return (
            <DropdownMenuItem
              key={agent.id}
              data-testid={`chat-stop-agent-${agent.id}`}
              disabled={state === "stopping"}
              onSelect={() => stop(agent)}
              className="flex items-center gap-2"
            >
              <Square className="h-2.5 w-2.5 fill-current" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{agent.name}</span>
              {agent.id === selectedAgentId && (
                <span className="text-xs text-muted-foreground">current</span>
              )}
              {state === "stopping" && (
                <Loader2
                  className="h-3 w-3 animate-spin"
                  aria-label="Stopping"
                />
              )}
              {state === "unconfirmed" && (
                <span className="text-xs text-muted-foreground">retry</span>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
