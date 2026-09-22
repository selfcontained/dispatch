import { useEffect } from "react";
import type {
  SharedUiEvent,
  StreamChangedEvent,
  StreamEntry,
  StreamEntryEvent,
  StreamReadEvent,
  StreamThreadResponse,
} from "@dispatch/shared";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useStore } from "jotai";
import {
  type Agent,
  type AuthState,
  type DiffStats,
  type FileItem,
} from "@/components/app/types";
import { agentDiffQueryKey } from "@/hooks/use-agent-diff";
import {
  applyStreamRead,
  bumpReplyCount,
  type FeedCache,
  LIVE_HEAD_ROWS,
  replaceThreadRoot,
  STREAM_QUERY_PREFIX,
  streamFeedQueryKey,
  threadQueryKey,
  upsertFeedEntry,
  upsertThreadReply,
} from "@/hooks/use-stream";
import { recordTurnLabel } from "@/hooks/use-agent-turn-label";
import { CHAT_UNREAD_QUERY_KEY } from "@/hooks/use-chat-unread-summary";
import { diffStatsQueryKey } from "@/hooks/use-agent-diff-stats";
import { FILE_ITEM_QUERY_PREFIX } from "@/hooks/use-files";
import { sortAgentsByCreatedAtDesc } from "@/lib/agent-sort";
import { recordSSEEvent, recordSSEReconnect } from "@/lib/energy-metrics";
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
  // The stream events are not in the shared union yet (packages/shared is
  // the server's to change); they ride the same SSE and are typed here.
  | StreamEntryEvent
  | StreamChangedEvent
  | StreamReadEvent
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

  const next = [...current];
  next[index] = incoming;
  return sortAgentsByCreatedAtDesc(next);
}

/**
 * The stream feed is composed server-side from several tables, so it is
 * invalidated on every event that touches one of its sources. Invalidation
 * only refetches a mounted feed, so this is free for every agent whose Chat
 * tab is not open.
 */
function invalidateStreamFeed(queryClient: QueryClient, agentId: string): void {
  void queryClient.invalidateQueries({
    queryKey: streamFeedQueryKey(agentId),
    exact: true,
  });
}

/**
 * A `stream.entry` event: one feed row, put straight into the cached pages.
 * Falls back to the refetch when there is no place for it — the entry is
 * older than the loaded head — or when a fetch is already in flight, whose
 * result would otherwise overwrite the patch with a snapshot that may or
 * may not include the row. A feed that was never fetched has nothing to
 * patch; its first fetch will carry the row.
 *
 * A reply (a block with `threadId`) never goes into the feed: it lands in
 * its thread when that is loaded, and the root's reply line counts it.
 */
export function applyStreamEntry(
  queryClient: QueryClient,
  agentId: string,
  entry: StreamEntry
): void {
  const key = streamFeedQueryKey(agentId);
  if (entry.type === "block" && entry.block.threadId !== null) {
    const reply = entry.block;
    queryClient.setQueryData<StreamThreadResponse>(
      threadQueryKey(agentId, reply.threadId),
      (old) => upsertThreadReply(old, reply)
    );
    queryClient.setQueryData<FeedCache>(key, (old) =>
      bumpReplyCount(old, reply)
    );
    return;
  }
  if (entry.type === "block") {
    // The panel shows a thread's root too; keep it in step with the feed.
    queryClient.setQueryData<StreamThreadResponse>(
      threadQueryKey(agentId, entry.block.id),
      (old) => replaceThreadRoot(old, entry.block)
    );
  }
  const state = queryClient.getQueryState<FeedCache>(key);
  if (!state?.data) return;
  if (state.fetchStatus === "fetching") {
    invalidateStreamFeed(queryClient, agentId);
    return;
  }
  const result = upsertFeedEntry(state.data, entry);
  if (!result.placed) {
    invalidateStreamFeed(queryClient, agentId);
    return;
  }
  if (result.cache !== state.data) queryClient.setQueryData(key, result.cache);
  // Live rows pile onto the newest page; past the bound, one refetch folds
  // them back into pages of the configured size.
  if (result.cache.pages[0]!.entries.length > LIVE_HEAD_ROWS) {
    invalidateStreamFeed(queryClient, agentId);
  }
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
    /** Turn blocks whose arrival has already refetched the unread badges. */
    const countedTurns = new Set<string>();

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
          void queryClient.invalidateQueries({
            queryKey: CHAT_UNREAD_QUERY_KEY,
          });
          // `stream.changed` is not replayed after a gap, so every mounted
          // feed (and open thread) refetches on (re)connect — otherwise an
          // open Chat tab keeps missing whatever landed while the stream was
          // down. Prefix match: one key per agent.
          void queryClient.invalidateQueries({ queryKey: STREAM_QUERY_PREFIX });
          return;
        }

        if (payload.type === "agent.upsert") {
          // Status events reach the feed as `stream.entry` rows of their own.
          queryClient.setQueryData<Agent[]>(["agents"], (old) =>
            applyAgentUpsert(old, payload.agent)
          );
          return;
        }

        if (payload.type === "agent.tool_invoked") {
          // Nothing in the column moves on a tool call; the turn's own
          // activity line covers it once the stream row lands.
          return;
        }

        if (payload.type === "stream.entry") {
          applyStreamEntry(queryClient, payload.agentId, payload.entry);
          recordTurnLabel(queryClient, payload.entry);
          // Only an agent's post for people can move the sidebar's unread
          // badges. A turn's block is republished on every step, but only
          // its first appearance adds to the count.
          const block =
            payload.entry.type === "block" ? payload.entry.block : null;
          if (
            block !== null &&
            block.author.kind === "agent" &&
            block.toAgentId === null &&
            (block.turn === undefined || !countedTurns.has(block.id))
          ) {
            if (block.turn !== undefined) countedTurns.add(block.id);
            void queryClient.invalidateQueries({
              queryKey: CHAT_UNREAD_QUERY_KEY,
            });
          }
          return;
        }

        if (payload.type === "stream.read") {
          queryClient.setQueryData<FeedCache>(
            streamFeedQueryKey(payload.agentId),
            (old) =>
              applyStreamRead(old, payload.unreadCount, {
                readAt: payload.readAt,
                upToAt: payload.upToAt,
              })
          );
          void queryClient.invalidateQueries({
            queryKey: CHAT_UNREAD_QUERY_KEY,
          });
          return;
        }

        if (payload.type === "stream.changed") {
          invalidateStreamFeed(queryClient, payload.agentId);
          void queryClient.invalidateQueries({
            queryKey: [...STREAM_QUERY_PREFIX, payload.agentId, "thread"],
          });
          void queryClient.invalidateQueries({
            queryKey: CHAT_UNREAD_QUERY_KEY,
          });
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

        if (payload.type === "files.changed") {
          void queryClient.invalidateQueries({
            queryKey: ["files", payload.agentId],
            exact: true,
          });
          void queryClient.invalidateQueries({
            queryKey: FILE_ITEM_QUERY_PREFIX,
          });
          invalidateStreamFeed(queryClient, payload.agentId);
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

        if (payload.type === "files.seen") {
          const seen = new Set(payload.keys);
          queryClient.setQueryData<FileItem[]>(
            ["files", payload.agentId],
            (old) =>
              old?.map((file) =>
                seen.has(`${file.name}:${file.updatedAt}`) && !file.seen
                  ? { ...file, seen: true }
                  : file
              )
          );
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
