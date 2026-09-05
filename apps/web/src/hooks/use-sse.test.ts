// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createStore, getDefaultStore, Provider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { agentDiffQueryKey } from "@/hooks/use-agent-diff";
import { diffStatsQueryKey } from "@/hooks/use-agent-diff-stats";
import { MEDIA_ITEM_QUERY_PREFIX } from "@/hooks/use-media";
import { CACHED_RELEASE_INFO_QUERY_KEY } from "@/hooks/use-cached-release-info";
import {
  agentToolBlipAtomFamily,
  whiteboardAgentDrewAtomFamily,
} from "@/lib/store";
import { showWebNotification } from "@/lib/web-notifications";

import {
  type Agent,
  type AuthState,
  type MediaFile,
} from "@/components/app/types";

import {
  applyAgentUpsert,
  applyDiffStateChanged,
  applyReviewCreated,
  useSSE,
} from "./use-sse";

vi.mock("@/lib/web-notifications", () => ({
  showWebNotification: vi.fn(() => false),
}));

function agent(
  id: string,
  submittedReviewId: number | null,
  createdAt = "2026-07-16T12:00:00.000Z"
): Agent {
  return { id, submittedReviewId, createdAt } as Agent;
}

describe("applyDiffStateChanged", () => {
  it("updates pushed stats and invalidates only committed-only stats", () => {
    const queryClient = new QueryClient();
    const includeUncommittedKey = diffStatsQueryKey("agent-1", true);
    const committedOnlyKey = diffStatsQueryKey("agent-1", false);
    const contentKey = [...agentDiffQueryKey("agent-1"), false, true] as const;

    queryClient.setQueryData(includeUncommittedKey, { added: 1, deleted: 1 });
    queryClient.setQueryData(committedOnlyKey, { added: 2, deleted: 2 });
    queryClient.setQueryData(contentKey, { files: [] });
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const pushedStats = {
      added: 3,
      deleted: 4,
      files: 2,
      computedAt: 123,
    };

    applyDiffStateChanged(queryClient, "agent-1", pushedStats);

    expect(queryClient.getQueryData(includeUncommittedKey)).toEqual(
      pushedStats
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: committedOnlyKey,
      exact: true,
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: includeUncommittedKey,
      exact: true,
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: agentDiffQueryKey("agent-1"),
    });
  });
});

describe("review submission SSE state", () => {
  it("marks the reviewer submitted when review.created arrives", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<Agent[]>(["agents"], [agent("reviewer", null)]);

    applyReviewCreated(queryClient, "reviewer", 42);

    expect(queryClient.getQueryData<Agent[]>(["agents"])?.[0]).toMatchObject({
      id: "reviewer",
      submittedReviewId: 42,
    });
  });

  it("does not let a stale agent upsert reactivate a submitted review", () => {
    const current = [agent("reviewer", 42)];
    const incoming = agent("reviewer", null);

    expect(applyAgentUpsert(current, incoming)[0]).toMatchObject({
      id: "reviewer",
      submittedReviewId: 42,
    });
  });
});

/**
 * Minimal EventSource stand-in. Real EventSource only auto-reconnects after
 * transient failures, so the tests drive `readyState` explicitly to
 * distinguish "browser is retrying" (CONNECTING) from "browser gave up"
 * (CLOSED) — the latter is the case the hook has to recover from itself.
 */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  /**
   * Simulate the connection establishing. Fires on the browser's own internal
   * retries too, which is what separates connection age from instance age.
   */
  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.(new Event("open"));
  }

  /** Simulate the server delivering an event (the hook's success signal). */
  emit(payload: unknown): void {
    this.readyState = FakeEventSource.OPEN;
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(payload) })
    );
  }

  /** Simulate a failure; `fatal` mirrors a non-200 / bad-content-type response. */
  fail(fatal: boolean): void {
    this.readyState = fatal
      ? FakeEventSource.CLOSED
      : FakeEventSource.CONNECTING;
    this.onerror?.(new Event("error"));
  }
}

describe("useSSE reconnect", () => {
  let hiddenValue = false;

  function renderSSE(authState: AuthState = "authenticated") {
    const queryClient = new QueryClient();
    const utils = renderHook(() => useSSE(authState), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children),
    });
    return { ...utils, queryClient };
  }

  /** Flip tab visibility the way a browser does — state change then event. */
  function setHidden(value: boolean) {
    hiddenValue = value;
    document.dispatchEvent(new Event("visibilitychange"));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    hiddenValue = false;
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hiddenValue);
  });

  afterEach(() => {
    // This config sets neither `globals: true` nor `setupFiles`, so React
    // Testing Library's auto-cleanup never registers — without an explicit
    // call, every hook stays mounted (listeners and all) for the rest of the
    // file and a leaked instance answers the next test's document events.
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("reopens the stream after a fatal error the browser will not retry", () => {
    renderSSE();
    expect(FakeEventSource.instances).toHaveLength(1);

    act(() => FakeEventSource.instances[0].fail(true));
    // Nothing yet — the retry is scheduled, not immediate.
    expect(FakeEventSource.instances).toHaveLength(1);

    act(() => void vi.advanceTimersByTime(1_000));
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("refetches every mounted chat feed when a reconnect snapshot lands", () => {
    // `chat.changed` is not replayed: a message written while the stream was
    // down only reaches an open Chat tab if the reconnect snapshot refetches
    // the feed itself, not just the sidebar's unread summary.
    const { queryClient } = renderSSE();
    queryClient.setQueryData(["chat", "agt_1"], { entries: ["stale"] });
    queryClient.setQueryData(["chat", "agt_2"], { entries: ["stale"] });
    expect(queryClient.getQueryState(["chat", "agt_1"])?.isInvalidated).toBe(
      false
    );

    // The server restarts; the message lands in the DB during the gap.
    act(() => FakeEventSource.instances[0].fail(true));
    act(() => void vi.advanceTimersByTime(1_000));
    expect(FakeEventSource.instances).toHaveLength(2);

    // Fresh connection, connect-time snapshot, no chat.changed replay.
    act(() =>
      FakeEventSource.instances[1].emit({ type: "snapshot", agents: [] })
    );

    expect(queryClient.getQueryState(["chat", "agt_1"])?.isInvalidated).toBe(
      true
    );
    expect(queryClient.getQueryState(["chat", "agt_2"])?.isInvalidated).toBe(
      true
    );
  });

  it("records a tool invocation as a blip for the presence strip", () => {
    vi.setSystemTime(new Date("2026-09-03T10:00:00.000Z"));
    renderSSE();
    act(() =>
      FakeEventSource.instances[0].emit({
        type: "agent.tool_invoked",
        agentId: "agt_1",
        tool: "dispatch_share_file",
        at: "2026-09-03T09:59:00.000Z",
      })
    );
    // Stamped with local receipt time, not the server's clock.
    expect(getDefaultStore().get(agentToolBlipAtomFamily("agt_1"))).toEqual({
      tool: "dispatch_share_file",
      at: Date.now(),
    });
  });

  it("leaves transient errors to the browser's own retry", () => {
    renderSSE();

    act(() => FakeEventSource.instances[0].fail(false));
    act(() => void vi.advanceTimersByTime(60_000));

    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("backs off exponentially while reconnects keep failing", () => {
    renderSSE();

    act(() => FakeEventSource.instances[0].fail(true));
    act(() => void vi.advanceTimersByTime(1_000));
    expect(FakeEventSource.instances).toHaveLength(2);

    act(() => FakeEventSource.instances[1].fail(true));
    act(() => void vi.advanceTimersByTime(1_000));
    // Second delay is 2s, so 1s is not enough.
    expect(FakeEventSource.instances).toHaveLength(2);

    act(() => void vi.advanceTimersByTime(1_000));
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it("resets the backoff once a connection has delivered and stayed up", () => {
    renderSSE();

    act(() => FakeEventSource.instances[0].fail(true));
    act(() => void vi.advanceTimersByTime(1_000));
    expect(FakeEventSource.instances).toHaveLength(2);

    // The reconnect holds long enough to count as healthy, then delivers.
    act(() => void vi.advanceTimersByTime(10_000));
    act(() =>
      FakeEventSource.instances[1].emit({ type: "snapshot", agents: [] })
    );

    // Backoff is back at the floor, so 1s is enough for the next retry.
    act(() => FakeEventSource.instances[1].fail(true));
    act(() => void vi.advanceTimersByTime(1_000));
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it("keeps backing off when a flapping server delivers only on connect", () => {
    // The server writes a snapshot the instant it accepts the connection, so a
    // short-lived connect delivers an event without ever being healthy. That
    // must not clear the backoff, or a flapping server pins us at the floor.
    renderSSE();

    act(() => FakeEventSource.instances[0].fail(true));
    act(() => void vi.advanceTimersByTime(1_000));
    expect(FakeEventSource.instances).toHaveLength(2);

    // Snapshot lands immediately on connect, then the stream dies right away.
    act(() =>
      FakeEventSource.instances[1].emit({ type: "snapshot", agents: [] })
    );
    act(() => FakeEventSource.instances[1].fail(true));

    // The delay kept doubling: 2s, so 1s must not be enough.
    act(() => void vi.advanceTimersByTime(1_000));
    expect(FakeEventSource.instances).toHaveLength(2);

    act(() => void vi.advanceTimersByTime(1_000));
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it("measures connection age, not instance age, across an internal retry", () => {
    // The browser reconnects transiently under the *same* instance without
    // re-running openSSE. A snapshot from that fresh connection must not clear
    // the backoff just because the instance itself is old.
    renderSSE();

    act(() => FakeEventSource.instances[0].fail(true));
    act(() => void vi.advanceTimersByTime(1_000));
    expect(FakeEventSource.instances).toHaveLength(2);

    const instance = FakeEventSource.instances[1];
    act(() => instance.open());
    act(() => void vi.advanceTimersByTime(10_000));

    // Transient drop, then the browser re-establishes on its own and the
    // server's connect-time snapshot lands on a seconds-old connection.
    act(() => instance.fail(false));
    act(() => instance.open());
    act(() => instance.emit({ type: "snapshot", agents: [] }));

    // Backoff must still be elevated: 2s, so 1s is not enough.
    act(() => instance.fail(true));
    act(() => void vi.advanceTimersByTime(1_000));
    expect(FakeEventSource.instances).toHaveLength(2);

    act(() => void vi.advanceTimersByTime(1_000));
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it("recovers when the tab is hidden while a retry is pending", () => {
    renderSSE();

    act(() => FakeEventSource.instances[0].fail(true));
    act(() => setHidden(true));

    // Hiding cancels the pending retry, so nothing reconnects behind the
    // user's back — the timer's own `document.hidden` guard never gets to run.
    act(() => void vi.advanceTimersByTime(60_000));
    expect(FakeEventSource.instances).toHaveLength(1);

    // Foregrounding is the escape hatch: reopen at once, and only once.
    act(() => setHidden(false));
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => void vi.advanceTimersByTime(60_000));
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("stops retrying after unmount", () => {
    const { unmount } = renderSSE();

    act(() => FakeEventSource.instances[0].fail(true));
    unmount();
    act(() => void vi.advanceTimersByTime(60_000));

    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("does not open a stream until the session is authenticated", () => {
    // The stream is credentialed; opening it before login just earns a 401
    // that the fatal-error path would then retry against forever.
    const { rerender } = renderHook(
      ({ authState }: { authState: AuthState }) => useSSE(authState),
      {
        initialProps: { authState: "loading" as AuthState },
        wrapper: ({ children }: { children: ReactNode }) =>
          createElement(
            QueryClientProvider,
            { client: new QueryClient() },
            children
          ),
      }
    );
    expect(FakeEventSource.instances).toHaveLength(0);

    act(() => void vi.advanceTimersByTime(60_000));
    expect(FakeEventSource.instances).toHaveLength(0);

    // Foregrounding is the one path that opens a stream without re-running the
    // effect, so it has to re-check auth rather than assume it.
    act(() => setHidden(true));
    act(() => setHidden(false));
    expect(FakeEventSource.instances).toHaveLength(0);

    rerender({ authState: "authenticated" as AuthState });
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("does not open a stream while the tab starts hidden", () => {
    hiddenValue = true;
    renderSSE();

    expect(FakeEventSource.instances).toHaveLength(0);

    act(() => setHidden(false));
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

/**
 * The message handler is the wiring hub for the whole realtime UI: every
 * server push lands here and is translated into a specific cache mutation or
 * invalidation. Drive the real hook through the fake stream rather than
 * calling helpers directly, so the routing itself — which payload reaches
 * which key — is what gets pinned.
 */
describe("useSSE message handling", () => {
  function renderMessages() {
    const queryClient = new QueryClient();
    const jotaiStore = createStore();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const removeQueries = vi.spyOn(queryClient, "removeQueries");

    const utils = renderHook(() => useSSE("authenticated"), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(
          Provider,
          { store: jotaiStore },
          createElement(QueryClientProvider, { client: queryClient }, children)
        ),
    });

    const source = FakeEventSource.instances[0]!;
    const emit = (payload: unknown) => act(() => source.emit(payload));
    /** Push a raw (possibly unparseable) frame the way the server would. */
    const emitRaw = (data: string) =>
      act(() => {
        source.onmessage?.(new MessageEvent("message", { data }));
      });

    return {
      queryClient,
      jotaiStore,
      invalidateQueries,
      removeQueries,
      emit,
      emitRaw,
      ...utils,
    };
  }

  /** Every queryKey passed to invalidateQueries, in call order. */
  function invalidatedKeys(spy: { mock: { calls: unknown[][] } }): unknown[] {
    return spy.mock.calls
      .map(
        ([filters]) => (filters as { queryKey?: unknown } | undefined)?.queryKey
      )
      .filter((key) => key !== undefined);
  }

  /**
   * Assert exactly this set of keys was invalidated — nothing missing, nothing
   * extra — without pinning the order. Within a single event the order the
   * branch happens to issue its invalidations in is not a contract, so
   * reordering them should stay a behavior-neutral refactor.
   */
  function expectInvalidatedSet(
    spy: { mock: { calls: unknown[][] } },
    expected: unknown[]
  ): void {
    const keys = invalidatedKeys(spy);
    expect(keys).toHaveLength(expected.length);
    expect(keys).toEqual(expect.arrayContaining(expected));
  }

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    fetchMock = vi.fn(() => Promise.resolve({} as Response));
    vi.stubGlobal("fetch", fetchMock);
    // vitest's restoreAllMocks only resets vi.spyOn spies, so a module-factory
    // vi.fn() keeps its call history and implementation across tests unless it
    // is reset explicitly here.
    vi.mocked(showWebNotification).mockReset();
    vi.mocked(showWebNotification).mockReturnValue(false);
  });

  afterEach(() => {
    // This config sets neither `globals: true` nor `setupFiles`, so RTL's
    // auto-cleanup never registers — see the note in the reconnect suite.
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("replaces the agent list from a snapshot in created-at order", () => {
    const { queryClient, emit } = renderMessages();
    queryClient.setQueryData<Agent[]>(["agents"], [agent("stale", null)]);

    emit({
      type: "snapshot",
      agents: [
        agent("older", null, "2026-07-16T10:00:00.000Z"),
        agent("newer", null, "2026-07-16T14:00:00.000Z"),
      ],
    });

    expect(
      queryClient.getQueryData<Agent[]>(["agents"])?.map((a) => a.id)
    ).toEqual(["newer", "older"]);
  });

  it("refetches the state a snapshot does not carry and drops injection holds", () => {
    // The snapshot payload only carries agents. Everything else the UI holds
    // could have changed during the gap, and injection-hold state is
    // event-sourced with no endpoint to refetch — so it has to fail safe.
    const { emit, invalidateQueries, removeQueries } = renderMessages();

    emit({ type: "snapshot", agents: [] });

    expectInvalidatedSet(invalidateQueries, [
      ["jobs"],
      ["templates"],
      ["brain"],
      ["whiteboard"],
      CACHED_RELEASE_INFO_QUERY_KEY,
      ["chat-unread"],
      ["chat"],
    ]);
    expect(removeQueries).toHaveBeenCalledWith({
      queryKey: ["injection-hold"],
    });
  });

  it("inserts an upserted agent in sorted position", () => {
    const { queryClient, emit } = renderMessages();
    queryClient.setQueryData<Agent[]>(
      ["agents"],
      [agent("old", null, "2026-07-16T10:00:00.000Z")]
    );

    emit({
      type: "agent.upsert",
      agent: agent("fresh", null, "2026-07-16T18:00:00.000Z"),
    });

    expect(
      queryClient.getQueryData<Agent[]>(["agents"])?.map((a) => a.id)
    ).toEqual(["fresh", "old"]);
  });

  it("removes only the deleted agent, and empties an unseeded list", () => {
    const { queryClient, emit } = renderMessages();
    queryClient.setQueryData<Agent[]>(
      ["agents"],
      [agent("keep", null), agent("drop", null)]
    );

    emit({ type: "agent.deleted", agentId: "drop" });

    expect(
      queryClient.getQueryData<Agent[]>(["agents"])?.map((a) => a.id)
    ).toEqual(["keep"]);

    // A delete for an agent list this tab never fetched must still leave a
    // defined (empty) list rather than writing undefined back over the key.
    queryClient.removeQueries({ queryKey: ["agents"] });
    emit({ type: "agent.deleted", agentId: "drop" });
    expect(queryClient.getQueryData<Agent[]>(["agents"])).toEqual([]);
  });

  it("writes terminal and injection-hold state under their agent keys", () => {
    const { queryClient, emit } = renderMessages();

    emit({
      type: "agent.terminal_state_changed",
      agentId: "a1",
      terminalState: { copyMode: "copy", lastObservedAt: 7 },
    });
    emit({
      type: "agent.injection_hold_changed",
      agentId: "a2",
      holdState: { held: true, pendingCount: 3, quietMs: 900 },
    });

    expect(queryClient.getQueryData(["terminal-state", "a1"])).toEqual({
      copyMode: "copy",
      lastObservedAt: 7,
    });
    expect(queryClient.getQueryData(["injection-hold", "a2"])).toEqual({
      held: true,
      pendingCount: 3,
      quietMs: 900,
    });
  });

  it("routes diff state to the include-uncommitted stats key", () => {
    const { queryClient, emit } = renderMessages();
    const pushed = { added: 3, deleted: 4, files: 2, computedAt: 123 };

    emit({
      type: "agent.diff_state_changed",
      agentId: "a1",
      diffStats: pushed,
    });

    expect(queryClient.getQueryData(diffStatsQueryKey("a1", true))).toEqual(
      pushed
    );
  });

  it("flips hasStream on the streaming agent only", () => {
    const { queryClient, emit } = renderMessages();
    queryClient.setQueryData<Agent[]>(
      ["agents"],
      [
        { ...agent("a1", null), hasStream: false } as Agent,
        { ...agent("a2", null), hasStream: false } as Agent,
      ]
    );

    emit({ type: "stream.started", agentId: "a1" });
    expect(
      queryClient
        .getQueryData<Agent[]>(["agents"])
        ?.map((a) => [a.id, a.hasStream])
    ).toEqual([
      ["a1", true],
      ["a2", false],
    ]);

    emit({ type: "stream.stopped", agentId: "a1" });
    expect(
      queryClient
        .getQueryData<Agent[]>(["agents"])
        ?.map((a) => [a.id, a.hasStream])
    ).toEqual([
      ["a1", false],
      ["a2", false],
    ]);
  });

  it("marks the agent-drew flag only when the agent did the drawing", () => {
    // The flag drives an attention affordance, so echoing the user's own
    // strokes back at them would make it permanently lit.
    const { jotaiStore, emit, invalidateQueries } = renderMessages();

    emit({
      type: "whiteboard.changed",
      agentId: "a1",
      version: 2,
      source: "user",
    });
    expect(jotaiStore.get(whiteboardAgentDrewAtomFamily("a1"))).toBe(false);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["whiteboard", "a1"],
      exact: true,
    });

    emit({
      type: "whiteboard.changed",
      agentId: "a1",
      version: 3,
      source: "agent",
    });
    expect(jotaiStore.get(whiteboardAgentDrewAtomFamily("a1"))).toBe(true);
    // Another agent's board is untouched by a1's stroke.
    expect(jotaiStore.get(whiteboardAgentDrewAtomFamily("a2"))).toBe(false);
  });

  it("marks seen only the media files named in the event", () => {
    const { queryClient, emit } = renderMessages();
    const file = (name: string, updatedAt: string): MediaFile => ({
      id: name.length,
      name,
      updatedAt,
      size: 1,
      url: `/media/${name}`,
    });
    queryClient.setQueryData<MediaFile[]>(
      ["media", "a1"],
      [
        file("shot.png", "2026-07-16T10:00:00.000Z"),
        file("other.png", "2026-07-16T10:00:00.000Z"),
        // Same name, newer revision — the key is name+updatedAt, so a stale
        // seen-key must not mark the replacement read.
        file("shot.png", "2026-07-16T11:00:00.000Z"),
      ]
    );

    emit({
      type: "media.seen",
      agentId: "a1",
      keys: ["shot.png:2026-07-16T10:00:00.000Z"],
    });

    expect(
      queryClient
        .getQueryData<MediaFile[]>(["media", "a1"])
        ?.map((f) => f.seen ?? false)
    ).toEqual([true, false, false]);
  });

  it("invalidates one agent's list and open media items on media.changed", () => {
    const { emit, invalidateQueries } = renderMessages();

    emit({ type: "media.changed", agentId: "a1" });

    // Exact, or every other agent's media list refetches on one screenshot.
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["media", "a1"],
      exact: true,
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: MEDIA_ITEM_QUERY_PREFIX,
    });
  });

  it("marks the reviewer submitted and refreshes review state on review.created", () => {
    const { queryClient, emit, invalidateQueries } = renderMessages();
    queryClient.setQueryData<Agent[]>(
      ["agents"],
      [agent("reviewer", null), agent("author", null)]
    );

    emit({
      type: "review.created",
      agentId: "author",
      reviewId: 42,
      reviewerAgentId: "reviewer",
    });

    expect(
      queryClient
        .getQueryData<Agent[]>(["agents"])
        ?.map((a) => a.submittedReviewId)
    ).toEqual([42, null]);
    expectInvalidatedSet(invalidateQueries, [
      ["agent-reviews", "author"],
      ["agent-feedback-items", "author"],
      // The Chat feed carries a card per review.
      ["chat", "author"],
    ]);
  });

  it("still refreshes review state when no reviewer is attributed", () => {
    // Human-authored reviews carry no reviewer agent. The missing attribution
    // must skip only the badge, not the refresh of the review lists.
    const { queryClient, emit, invalidateQueries } = renderMessages();
    queryClient.setQueryData<Agent[]>(["agents"], [agent("author", null)]);

    emit({
      type: "review.created",
      agentId: "author",
      reviewId: 42,
      reviewerAgentId: null,
    });

    expect(
      queryClient.getQueryData<Agent[]>(["agents"])?.[0]?.submittedReviewId
    ).toBeNull();
    expectInvalidatedSet(invalidateQueries, [
      ["agent-reviews", "author"],
      ["agent-feedback-items", "author"],
      // The Chat feed carries a card per review.
      ["chat", "author"],
    ]);
  });

  it("scopes the review-detail predicate to the event's agent", () => {
    const { emit, invalidateQueries } = renderMessages();

    emit({ type: "review.updated", agentId: "author" });

    const predicate = invalidateQueries.mock.calls
      .map(
        ([filters]) =>
          (filters as { predicate?: (q: unknown) => boolean }).predicate
      )
      .find(Boolean)!;
    const matches = (queryKey: unknown[]) => predicate({ queryKey } as never);

    expect(matches(["agent-review-detail", "author", 1])).toBe(true);
    expect(matches(["agent-review-detail", "someone-else", 1])).toBe(false);
    expect(matches(["agent-reviews", "author"])).toBe(false);
  });

  it("leaves submittedReviewId alone for review updates", () => {
    // Only creation carries a reviewId; an update must not clear or reassign
    // the badge the reviewer already earned.
    const { queryClient, emit } = renderMessages();
    queryClient.setQueryData<Agent[]>(["agents"], [agent("reviewer", 42)]);

    emit({ type: "review_feedback.updated", agentId: "reviewer" });

    expect(
      queryClient.getQueryData<Agent[]>(["agents"])?.[0]?.submittedReviewId
    ).toBe(42);
  });

  it("refetches an agent's chat feed and the sidebar unread summary on chat.changed", () => {
    const { emit, invalidateQueries } = renderMessages();

    emit({ type: "chat.changed", agentId: "agt_1" });
    expectInvalidatedSet(invalidateQueries, [
      ["chat", "agt_1"],
      ["chat-unread"],
    ]);
  });

  it("invalidates both ends of a created message and only one on read", () => {
    const { emit, invalidateQueries } = renderMessages();

    emit({
      type: "message.created",
      senderAgentId: "sender",
      recipientAgentId: "recipient",
    });
    // Cross-agent messages also appear in both agents' chat feeds.
    expectInvalidatedSet(invalidateQueries, [
      ["messages", "sender"],
      ["messages", "recipient"],
      ["chat", "sender"],
      ["chat", "recipient"],
    ]);

    invalidateQueries.mockClear();
    emit({ type: "message.read", agentId: "recipient" });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["messages", "recipient"],
      exact: true,
    });
  });

  it("invalidates the collection each bare change event names", () => {
    const { emit, invalidateQueries } = renderMessages();

    emit({ type: "job.changed" });
    emit({ type: "template.changed" });
    emit({ type: "brain.changed", repoRoot: "/repo" });

    // Ordered on purpose here, unlike the within-one-event assertions above:
    // the sequence is the test's own emit order, so it is what proves each
    // event invalidates its own collection instead of all three sharing one.
    expect(invalidatedKeys(invalidateQueries)).toEqual([
      ["jobs"],
      ["agents"],
      ["templates"],
      ["brain"],
    ]);
  });

  it("acks a notification only when one was actually shown", () => {
    const { emit } = renderMessages();
    const payload = {
      type: "notification",
      notificationId: "n1",
      agentId: "a1",
      agentName: "Agent One",
      eventType: "done",
      message: "finished",
    };

    // Permission denied — nothing was displayed, so the server must keep the
    // notification queued for whichever tab can show it.
    emit(payload);
    expect(showWebNotification).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: "Agent One", eventType: "done" })
    );
    expect(fetchMock).not.toHaveBeenCalled();

    vi.mocked(showWebNotification).mockReturnValue(true);
    emit(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/notifications/ack",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        // keepalive, or the ack is cancelled when the click navigates away.
        keepalive: true,
        body: JSON.stringify({ notificationId: "n1" }),
      })
    );
  });

  it("handles the rejection of a fire-and-forget ack", async () => {
    // The ack is never awaited, so a failed one — offline, server restarting —
    // has to be swallowed at the call site or it surfaces as an unhandled
    // rejection in the user's console. Assert the handler is attached rather
    // than that nothing threw: the whole dispatch runs inside a try/catch, so
    // a not-toThrow assertion here would pass with the .catch() deleted.
    const { emit } = renderMessages();
    vi.mocked(showWebNotification).mockReturnValue(true);
    const rejection = Promise.reject(new Error("offline"));
    const attachCatch = vi.spyOn(rejection, "catch");
    fetchMock.mockReturnValueOnce(rejection);

    emit({
      type: "notification",
      notificationId: "n1",
      agentId: "a1",
      agentName: "Agent One",
      eventType: "done",
      message: "finished",
    });

    expect(attachCatch).toHaveBeenCalled();
    await act(async () => {});
    rejection.catch(() => {});
  });

  it("caches a pushed release snapshot under the response shape", () => {
    const { queryClient, emit } = renderMessages();
    const snapshot = { currentTag: "v1.0.0", updateAvailable: true };

    emit({ type: "release.cached_info_changed", snapshot });

    // The query's own fetch returns { snapshot }, so the push has to match or
    // consumers read undefined off a populated cache.
    expect(queryClient.getQueryData(CACHED_RELEASE_INFO_QUERY_KEY)).toEqual({
      snapshot,
    });
  });

  it("ignores an unparseable frame and keeps handling the next one", () => {
    const { queryClient, emit, emitRaw } = renderMessages();
    queryClient.setQueryData<Agent[]>(["agents"], [agent("keep", null)]);

    expect(() => emitRaw("not json")).not.toThrow();
    expect(
      queryClient.getQueryData<Agent[]>(["agents"])?.map((a) => a.id)
    ).toEqual(["keep"]);

    // A poisoned frame must not wedge the stream.
    emit({ type: "agent.deleted", agentId: "keep" });
    expect(queryClient.getQueryData<Agent[]>(["agents"])).toEqual([]);
  });

  it("ignores an event type it does not know", () => {
    const { queryClient, emit, invalidateQueries } = renderMessages();
    queryClient.setQueryData<Agent[]>(["agents"], [agent("keep", null)]);

    emit({ type: "agent.invented_by_a_newer_server", agentId: "keep" });

    expect(
      queryClient.getQueryData<Agent[]>(["agents"])?.map((a) => a.id)
    ).toEqual(["keep"]);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});
