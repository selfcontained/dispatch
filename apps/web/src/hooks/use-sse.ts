import { useEffect, useRef } from "react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import {
  type Agent,
  type AuthState,
  type DiffStats,
  type MediaFile,
  type TerminalUiState,
} from "@/components/app/types";
import { agentDiffQueryKey } from "@/hooks/use-agent-diff";
import { diffStatsQueryKey } from "@/hooks/use-agent-diff-stats";
import { sortAgentsByCreatedAtDesc } from "@/lib/agent-sort";
import { recordSSEEvent, recordSSEReconnect } from "@/lib/energy-metrics";
import { showWebNotification } from "@/lib/web-notifications";
import {
  CACHED_RELEASE_INFO_QUERY_KEY,
  type ReleaseInfoSnapshot,
} from "@/hooks/use-cached-release-info";

type UiEvent =
  | { type: "snapshot"; agents: Agent[] }
  | { type: "agent.upsert"; agent: Agent }
  | {
      type: "agent.terminal_state_changed";
      agentId: string;
      terminalState: TerminalUiState;
    }
  | {
      type: "agent.diff_state_changed";
      agentId: string;
      diffStats: DiffStats | null;
    }
  | { type: "agent.deleted"; agentId: string }
  | { type: "media.changed"; agentId: string }
  | { type: "media.seen"; agentId: string; keys: string[] }
  | { type: "stream.started"; agentId: string }
  | { type: "stream.stopped"; agentId: string }
  | { type: "feedback.created"; agentId: string }
  | { type: "feedback.updated"; agentId: string }
  | {
      type: "review.created";
      agentId: string;
      reviewerAgentId?: string | null;
    }
  | { type: "review.updated"; agentId: string }
  | { type: "review_feedback.updated"; agentId: string }
  | { type: "job.changed" }
  | { type: "template.changed" }
  | { type: "brain.changed"; repoRoot: string }
  | { type: "message.created"; senderAgentId: string; recipientAgentId: string }
  | { type: "message.read"; agentId: string }
  | {
      type: "notification";
      notificationId: string;
      agentId: string;
      agentName: string;
      eventType: string;
      message: string;
    }
  | {
      type: "release.cached_info_changed";
      snapshot: ReleaseInfoSnapshot | null;
    };

function patchAgentHasStream(
  queryClient: ReturnType<typeof useQueryClient>,
  agentId: string,
  hasStream: boolean
): void {
  queryClient.setQueryData<Agent[]>(["agents"], (old) =>
    old?.map((a) =>
      a.id === agentId && a.hasStream !== hasStream ? { ...a, hasStream } : a
    )
  );
}

export function applyDiffStateChanged(
  queryClient: QueryClient,
  agentId: string,
  diffStats: DiffStats | null
): void {
  queryClient.setQueryData<DiffStats | null>(
    diffStatsQueryKey(agentId, true),
    diffStats
  );
  void queryClient.invalidateQueries({
    queryKey: diffStatsQueryKey(agentId, false),
    exact: true,
  });
  void queryClient.invalidateQueries({
    queryKey: agentDiffQueryKey(agentId),
  });
}

export function applyAgentUpsert(
  current: Agent[] | undefined,
  incoming: Agent
): Agent[] {
  if (!current) return [incoming];
  const index = current.findIndex((agent) => agent.id === incoming.id);
  if (index === -1) {
    return sortAgentsByCreatedAtDesc([incoming, ...current]);
  }

  const existing = current[index]!;
  const nextAgent =
    existing.hasSubmittedReview && !incoming.hasSubmittedReview
      ? { ...incoming, hasSubmittedReview: true }
      : incoming;
  const next = [...current];
  next[index] = nextAgent;
  return sortAgentsByCreatedAtDesc(next);
}

export function applyReviewCreated(
  queryClient: QueryClient,
  reviewerAgentId: string | null | undefined
): void {
  if (!reviewerAgentId) return;
  queryClient.setQueryData<Agent[]>(["agents"], (old) =>
    old?.map((agent) =>
      agent.id === reviewerAgentId && !agent.hasSubmittedReview
        ? { ...agent, hasSubmittedReview: true }
        : agent
    )
  );
}

export function useSSE(authState: AuthState): void {
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
          // A snapshot means a fresh SSE connection (initial or reconnect).
          // Invalidate the queries that aren't carried in the snapshot
          // payload — jobs and the cached release info — so they refetch.
          // Without this, a tab that was hidden/disconnected during a
          // `release.cached_info_changed` event would keep stale release
          // state forever (the query has staleTime: Infinity).
          void queryClient.invalidateQueries({ queryKey: ["jobs"] });
          void queryClient.invalidateQueries({ queryKey: ["templates"] });
          void queryClient.invalidateQueries({ queryKey: ["brain"] });
          void queryClient.invalidateQueries({
            queryKey: CACHED_RELEASE_INFO_QUERY_KEY,
          });
          return;
        }

        if (payload.type === "agent.upsert") {
          queryClient.setQueryData<Agent[]>(["agents"], (old) =>
            applyAgentUpsert(old, payload.agent)
          );
          return;
        }

        if (payload.type === "agent.terminal_state_changed") {
          queryClient.setQueryData<TerminalUiState>(
            ["terminal-state", payload.agentId],
            payload.terminalState
          );
          return;
        }

        if (payload.type === "agent.diff_state_changed") {
          applyDiffStateChanged(
            queryClient,
            payload.agentId,
            payload.diffStats
          );
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
          void queryClient.invalidateQueries({
            queryKey: ["media", payload.agentId],
            exact: true,
          });
          return;
        }

        if (payload.type === "stream.started") {
          patchAgentHasStream(queryClient, payload.agentId, true);
          return;
        }

        if (payload.type === "stream.stopped") {
          patchAgentHasStream(queryClient, payload.agentId, false);
          return;
        }

        if (payload.type === "media.seen") {
          const seen = new Set(payload.keys);
          queryClient.setQueryData<MediaFile[]>(
            ["media", payload.agentId],
            (old) =>
              old?.map((file) =>
                seen.has(`${file.name}:${file.updatedAt}`) && !file.seen
                  ? { ...file, seen: true }
                  : file
              )
          );
          return;
        }

        if (
          payload.type === "feedback.created" ||
          payload.type === "feedback.updated"
        ) {
          void queryClient.invalidateQueries({ queryKey: ["feedback"] });
          return;
        }

        if (
          payload.type === "review.created" ||
          payload.type === "review.updated" ||
          payload.type === "review_feedback.updated"
        ) {
          if (payload.type === "review.created") {
            applyReviewCreated(queryClient, payload.reviewerAgentId);
          }
          void queryClient.invalidateQueries({
            queryKey: ["agent-reviews", payload.agentId],
          });
          void queryClient.invalidateQueries({
            predicate: (q) =>
              q.queryKey[0] === "agent-review-detail" &&
              q.queryKey[1] === payload.agentId,
          });
          void queryClient.invalidateQueries({
            queryKey: ["agent-feedback-items", payload.agentId],
          });
          return;
        }

        if (payload.type === "job.changed") {
          void queryClient.invalidateQueries({ queryKey: ["jobs"] });
          return;
        }

        if (payload.type === "template.changed") {
          void queryClient.invalidateQueries({ queryKey: ["templates"] });
          return;
        }

        if (payload.type === "brain.changed") {
          void queryClient.invalidateQueries({ queryKey: ["brain"] });
          return;
        }

        if (payload.type === "message.created") {
          void queryClient.invalidateQueries({
            queryKey: ["messages", payload.senderAgentId],
            exact: true,
          });
          void queryClient.invalidateQueries({
            queryKey: ["messages", payload.recipientAgentId],
            exact: true,
          });
          return;
        }

        if (payload.type === "message.read") {
          void queryClient.invalidateQueries({
            queryKey: ["messages", payload.agentId],
            exact: true,
          });
          return;
        }

        if (payload.type === "notification") {
          const shown = showWebNotification(payload);
          if (shown) {
            void fetch("/api/v1/notifications/ack", {
              method: "POST",
              credentials: "include",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ notificationId: payload.notificationId }),
              keepalive: true,
            }).catch(() => {});
          }
          return;
        }

        if (payload.type === "release.cached_info_changed") {
          queryClient.setQueryData(CACHED_RELEASE_INFO_QUERY_KEY, {
            snapshot: payload.snapshot,
          });
          return;
        }
      } catch {}
    };

    const openSSE = () => {
      if (eventSourceRef.current) return;
      const source = new EventSource("/api/v1/events", {
        withCredentials: true,
      });
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
  }, [authState, queryClient]);
}
