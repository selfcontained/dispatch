import { useEffect } from "react";
import type { SharedUiEvent } from "@dispatch/shared";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useStore } from "jotai";
import {
  type Agent,
  type AuthState,
  type DiffStats,
  type InjectionHoldState,
  type MediaFile,
  type TerminalUiState,
} from "@/components/app/types";
import { agentDiffQueryKey } from "@/hooks/use-agent-diff";
import { CHAT_QUERY_PREFIX, chatFeedQueryKey } from "@/hooks/use-chat";
import { harnessConfigQueryKey } from "@/components/app/harness/use-harness-config";
import { harnessTurnsQueryKey } from "@/components/app/harness/use-harness-turns";
import { CHAT_UNREAD_QUERY_KEY } from "@/hooks/use-chat-unread-summary";
import { surfacesQueryKey } from "@/hooks/use-agent-surfaces";
import { diffStatsQueryKey } from "@/hooks/use-agent-diff-stats";
import { sortAgentsByCreatedAtDesc } from "@/lib/agent-sort";
import { recordSSEEvent, recordSSEReconnect } from "@/lib/energy-metrics";
import {
  agentToolBlipAtomFamily,
  whiteboardAgentDrewAtomFamily,
} from "@/lib/store";
import { showWebNotification } from "@/lib/web-notifications";
import {
  CACHED_RELEASE_INFO_QUERY_KEY,
  type ReleaseInfoSnapshot,
} from "@/hooks/use-cached-release-info";

/** Backoff bounds for self-driven reconnects after a fatal EventSource error. */
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
/**
 * How long a connection must last before a delivered event counts as proof
 * that it is healthy.
 *
 * A delivered event on its own proves only that the *connect* succeeded: the
 * server writes the snapshot the moment it accepts the connection (see
 * `sendUiSnapshot` in apps/server/src/routes/agents/events-routes.ts, called
 * immediately after accept). Clearing the backoff on that lets a flapping
 * server pin every tab at the 1s floor forever — connect, snapshot, reset,
 * drop, repeat — so the cap never engages in the case it exists for.
 *
 * The reset stays keyed on a delivered event rather than a bare timer, so a
 * hung proxy holding the socket open without sending anything can't clear the
 * backoff either. Tradeoff: a connection that stays healthy but silent for its
 * whole life fails with an elevated delay (capped at MAX_RECONNECT_DELAY_MS,
 * and cleared on tab foreground) — acceptable for a stream this chatty.
 */
const STABLE_CONNECTION_MS = 10_000;

/**
 * The four members whose payloads differ from the server's declaration — see
 * `SharedUiEvent` in `@dispatch/shared` for why each one stays per side.
 * Every other member of the stream comes from that shared union.
 */
type UiEvent =
  | { type: "snapshot"; agents: Agent[] }
  | { type: "agent.upsert"; agent: Agent }
  | {
      type: "agent.diff_state_changed";
      agentId: string;
      diffStats: DiffStats | null;
    }
  | {
      type: "release.cached_info_changed";
      snapshot: ReleaseInfoSnapshot | null;
    }
  | SharedUiEvent;

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
    existing.submittedReviewId != null
      ? {
          ...incoming,
          submittedReviewId:
            incoming.submittedReviewId ?? existing.submittedReviewId,
        }
      : incoming;
  const next = [...current];
  next[index] = nextAgent;
  return sortAgentsByCreatedAtDesc(next);
}

/**
 * The chat feed is composed server-side from several tables, so it is
 * invalidated on every event that touches one of its sources. Invalidation
 * only refetches a mounted feed, so this is free for every agent whose Chat
 * tab is not open.
 */
function invalidateChatFeed(queryClient: QueryClient, agentId: string): void {
  void queryClient.invalidateQueries({
    queryKey: chatFeedQueryKey(agentId),
    exact: true,
  });
  // The Harness view reads the same stream rows the feed does, and settles
  // on the same signals (agent events, chat changes), so it refetches with it.
  void queryClient.invalidateQueries({
    queryKey: harnessTurnsQueryKey(agentId),
    exact: true,
  });
  // The session config (model, effort, running) changes on the same
  // events: a start, a settle, a switch.
  void queryClient.invalidateQueries({
    queryKey: harnessConfigQueryKey(agentId),
    exact: true,
  });
}

export function applyReviewCreated(
  queryClient: QueryClient,
  reviewerAgentId: string | null | undefined,
  reviewId: number
): void {
  if (!reviewerAgentId) return;
  queryClient.setQueryData<Agent[]>(["agents"], (old) =>
    old?.map((agent) =>
      agent.id === reviewerAgentId && agent.submittedReviewId !== reviewId
        ? { ...agent, submittedReviewId: reviewId }
        : agent
    )
  );
}

export function useSSE(authState: AuthState): void {
  const queryClient = useQueryClient();
  const jotaiStore = useStore();
  useEffect(() => {
    // EventSource only auto-reconnects after *transient* failures. A fatal
    // one (non-200 response, wrong content-type — e.g. hitting the server
    // mid-restart) moves it to CLOSED permanently, and nothing here noticed:
    // the dead instance stayed put, so `openSSE` early-returned forever and a
    // visible tab silently lost every realtime update. We drive our own capped
    // backoff for that case.
    //
    // The connection and its backoff are one state machine, so they share one
    // lifetime: all of it is effect-scoped and torn down together. Nothing
    // here is read during render, so none of it needs to be a ref.
    let source: EventSource | null = null;
    let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    /** When the current connection last established — or, before it has
     *  opened, when we started attempting it. */
    let connectionAliveSince = 0;

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
          void queryClient.invalidateQueries({ queryKey: ["whiteboard"] });
          void queryClient.invalidateQueries({
            queryKey: CACHED_RELEASE_INFO_QUERY_KEY,
          });
          void queryClient.invalidateQueries({
            queryKey: CHAT_UNREAD_QUERY_KEY,
          });
          // `chat.changed` is not replayed after a gap, so every mounted chat
          // feed refetches on (re)connect — otherwise an open Chat tab keeps
          // missing whatever landed while the stream was down. Prefix match:
          // one key per agent.
          void queryClient.invalidateQueries({ queryKey: CHAT_QUERY_PREFIX });
          void queryClient.invalidateQueries({ queryKey: ["harness-turns"] });
          void queryClient.invalidateQueries({ queryKey: ["harness-config"] });
          // Injection-hold state is event-sourced with no fetch endpoint; a
          // release event missed during an SSE gap would leave the hold badge
          // stuck. Reset on every (re)connect snapshot — fails safe to hidden.
          queryClient.removeQueries({ queryKey: ["injection-hold"] });
          return;
        }

        if (payload.type === "agent.upsert") {
          // Status events reach the feed through the agent row's latestEvent;
          // an upsert that changed nothing about it (name edit, pin update)
          // has nothing new for the feed.
          const existing = queryClient
            .getQueryData<Agent[]>(["agents"])
            ?.find((a) => a.id === payload.agent.id);
          const eventChanged =
            !existing ||
            existing.latestEvent?.updatedAt !==
              payload.agent.latestEvent?.updatedAt ||
            existing.latestEvent?.message !==
              payload.agent.latestEvent?.message;
          queryClient.setQueryData<Agent[]>(["agents"], (old) =>
            applyAgentUpsert(old, payload.agent)
          );
          if (eventChanged) invalidateChatFeed(queryClient, payload.agent.id);
          return;
        }

        if (payload.type === "agent.tool_invoked") {
          // Ephemeral: the presence strip shows it for a few seconds. Local
          // receipt time keeps the blip's timer independent of clock skew.
          jotaiStore.set(agentToolBlipAtomFamily(payload.agentId), {
            tool: payload.tool,
            at: Date.now(),
          });
          return;
        }

        if (payload.type === "chat.changed") {
          invalidateChatFeed(queryClient, payload.agentId);
          void queryClient.invalidateQueries({
            queryKey: CHAT_UNREAD_QUERY_KEY,
          });
          return;
        }

        if (payload.type === "agent.terminal_state_changed") {
          queryClient.setQueryData<TerminalUiState>(
            ["terminal-state", payload.agentId],
            payload.terminalState
          );
          return;
        }

        if (payload.type === "agent.injection_hold_changed") {
          queryClient.setQueryData<InjectionHoldState>(
            ["injection-hold", payload.agentId],
            payload.holdState
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
          invalidateChatFeed(queryClient, payload.agentId);
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

        if (payload.type === "whiteboard.changed") {
          void queryClient.invalidateQueries({
            queryKey: ["whiteboard", payload.agentId],
            exact: true,
          });
          if (payload.source === "agent") {
            jotaiStore.set(
              whiteboardAgentDrewAtomFamily(payload.agentId),
              true
            );
          }
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
          payload.type === "review.created" ||
          payload.type === "review.updated" ||
          payload.type === "review_feedback.updated"
        ) {
          if (payload.type === "review.created") {
            applyReviewCreated(
              queryClient,
              payload.reviewerAgentId,
              payload.reviewId
            );
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
          // The Chat feed renders reviews as cards, with their live status
          // and counts — so a new review, and every later change to one,
          // has to reach the feed too.
          invalidateChatFeed(queryClient, payload.agentId);
          return;
        }

        if (payload.type === "job.changed") {
          void queryClient.invalidateQueries({ queryKey: ["jobs"] });
          // A job agent is announced before its run is attached. Refetch so
          // the sidebar receives its loop iteration metadata immediately.
          void queryClient.invalidateQueries({ queryKey: ["agents"] });
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
          invalidateChatFeed(queryClient, payload.senderAgentId);
          invalidateChatFeed(queryClient, payload.recipientAgentId);
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

        if (payload.type === "surface.changed") {
          void queryClient.invalidateQueries({
            queryKey: surfacesQueryKey(payload.agentId),
            exact: true,
          });
          return;
        }
      } catch {}
    };

    const cancelReconnect = () => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    /** A delivered event clears the backoff, but only once the connection has
     *  proven it can last — see STABLE_CONNECTION_MS. */
    const noteStreamActivity = () => {
      if (Date.now() - connectionAliveSince >= STABLE_CONNECTION_MS) {
        reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      }
    };

    const scheduleReconnect = () => {
      if (reconnectTimer !== null) return;
      const delay = reconnectDelayMs;
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (document.hidden) return;
        openSSE();
      }, delay);
    };

    const openSSE = () => {
      // A live source and a pending retry are mutually exclusive: a retry is
      // only ever scheduled after the source is dropped.
      if (source) return;
      cancelReconnect();
      const opened = new EventSource("/api/v1/events", {
        withCredentials: true,
      });
      // No `open` yet, so measure from the attempt. Generous by the
      // establishment latency, but never 0 — a zero here would make the
      // staleness check trivially true and silently clear the backoff.
      connectionAliveSince = Date.now();
      source = opened;
      // `open` fires on every establishment, including the browser's own
      // internal retries after a transient drop. Those never re-run `openSSE`,
      // so without this the gate would measure the age of the *instance*
      // rather than of the connection, and a connect-time snapshot delivered
      // by an internal retry would clear the backoff — the exact event the
      // gate exists to discount.
      opened.onopen = () => {
        connectionAliveSince = Date.now();
      };
      opened.onmessage = (event) => {
        noteStreamActivity();
        handleSSEMessage(event);
      };
      opened.onerror = () => {
        recordSSEReconnect();
        // CONNECTING means the browser is retrying on its own — leave it be.
        // CLOSED means it has given up; the instance is dead, so drop it and
        // retry ourselves.
        if (opened.readyState !== EventSource.CLOSED) return;
        opened.close();
        // `close()` aborts queued dispatches, so a replaced instance can't
        // reach here in a conformant browser. Keep the whole branch behind the
        // identity check anyway: scheduling a retry beside a live connection
        // would double the delay for nothing.
        if (source !== opened) return;
        source = null;
        scheduleReconnect();
      };
    };

    const closeSSE = () => {
      cancelReconnect();
      if (source) {
        source.close();
        source = null;
      }
    };

    if (!document.hidden && authState === "authenticated") {
      openSSE();
    }

    const onVisChange = () => {
      if (document.hidden || authState !== "authenticated") {
        closeSSE();
      } else {
        // Foregrounding is a fresh start — don't inherit a backed-off delay
        // from whatever killed the previous connection.
        reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
        openSSE();
      }
    };

    document.addEventListener("visibilitychange", onVisChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisChange);
      closeSSE();
    };
  }, [authState, queryClient, jotaiStore]);
}
