import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { type Agent, type AuthState } from "@/components/app/types";
import { sortAgentsByCreatedAtDesc } from "@/lib/agent-sort";
import { recordSSEEvent, recordSSEReconnect } from "@/lib/energy-metrics";

type UiEvent =
  | { type: "snapshot"; agents: Agent[] }
  | { type: "agent.upsert"; agent: Agent }
  | { type: "agent.deleted"; agentId: string }
  | { type: "media.changed"; agentId: string }
  | { type: "media.seen"; agentId: string; keys: string[] }
  | { type: "stream.started"; agentId: string }
  | { type: "stream.stopped"; agentId: string }
  | { type: "feedback.created"; agentId: string };

export function useSSE(
  authState: AuthState,
  connectedAgentIdRef: React.RefObject<string | null>,
  selectedAgentIdRef: React.RefObject<string | null>,
  setStreamingAgentIds: React.Dispatch<React.SetStateAction<Set<string>>>,
  markSeenInCache: (agentId: string, keys: Set<string>) => void,
): void {
  const queryClient = useQueryClient();
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const handleSSEMessage = (event: MessageEvent) => {
      try {
        recordSSEEvent();
        const payload = JSON.parse(event.data) as UiEvent;

        if (payload.type === "snapshot") {
          queryClient.setQueryData<Agent[]>(
            ["agents"],
            sortAgentsByCreatedAtDesc(payload.agents)
          );
          setStreamingAgentIds(
            new Set(payload.agents.filter((a) => a.hasStream).map((a) => a.id))
          );
          return;
        }

        if (payload.type === "agent.upsert") {
          queryClient.setQueryData<Agent[]>(["agents"], (old) => {
            if (!old) return [payload.agent];
            const index = old.findIndex((a) => a.id === payload.agent.id);
            if (index === -1) {
              return sortAgentsByCreatedAtDesc([payload.agent, ...old]);
            }
            const next = [...old];
            next[index] = payload.agent;
            return sortAgentsByCreatedAtDesc(next);
          });
          return;
        }

        if (payload.type === "agent.deleted") {
          queryClient.setQueryData<Agent[]>(
            ["agents"],
            (old) => old?.filter((a) => a.id !== payload.agentId) ?? []
          );
          return;
        }

        if (payload.type === "media.changed") {
          void queryClient.invalidateQueries({ queryKey: ["media", payload.agentId], exact: true });
          return;
        }

        if (payload.type === "stream.started") {
          setStreamingAgentIds((current) => {
            if (current.has(payload.agentId)) return current;
            const next = new Set(current);
            next.add(payload.agentId);
            return next;
          });
          return;
        }

        if (payload.type === "stream.stopped") {
          setStreamingAgentIds((current) => {
            if (!current.has(payload.agentId)) return current;
            const next = new Set(current);
            next.delete(payload.agentId);
            return next;
          });
          return;
        }

        if (payload.type === "media.seen") {
          markSeenInCache(payload.agentId, new Set(payload.keys));
          return;
        }

        if (payload.type === "feedback.created") {
          void queryClient.invalidateQueries({ queryKey: ["feedback", payload.agentId], exact: true });
        }
      } catch {}
    };

    const openSSE = () => {
      if (eventSourceRef.current) return;
      const source = new EventSource("/api/v1/events", { withCredentials: true });
      eventSourceRef.current = source;
      source.onmessage = handleSSEMessage;
      source.onerror = () => {
        recordSSEReconnect();
      };
    };

    const closeSSE = () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };

    if (!document.hidden && authState === "authenticated") {
      openSSE();
    }

    const onVisChange = () => {
      if (document.hidden || authState !== "authenticated") {
        closeSSE();
      } else {
        openSSE();
      }
    };

    document.addEventListener("visibilitychange", onVisChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisChange);
      closeSSE();
    };
  }, [authState, connectedAgentIdRef, markSeenInCache, queryClient, selectedAgentIdRef, setStreamingAgentIds]);
}
