// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { agentDiffQueryKey } from "@/hooks/use-agent-diff";
import { diffStatsQueryKey } from "@/hooks/use-agent-diff-stats";

import { type Agent } from "@/components/app/types";

import {
  applyAgentUpsert,
  applyDiffStateChanged,
  applyReviewCreated,
  useSSE,
} from "./use-sse";

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
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
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
  let originalEventSource: typeof globalThis.EventSource;

  function renderSSE() {
    const queryClient = new QueryClient();
    return renderHook(() => useSSE("authenticated"), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children),
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    originalEventSource = globalThis.EventSource;
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  });

  afterEach(() => {
    globalThis.EventSource = originalEventSource;
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

  it("resets the backoff once the stream delivers again", () => {
    renderSSE();

    act(() => FakeEventSource.instances[0].fail(true));
    act(() => void vi.advanceTimersByTime(1_000));
    expect(FakeEventSource.instances).toHaveLength(2);

    // A snapshot arrives — the connection is healthy again.
    act(() =>
      FakeEventSource.instances[1].emit({ type: "snapshot", agents: [] })
    );

    act(() => FakeEventSource.instances[1].fail(true));
    act(() => void vi.advanceTimersByTime(1_000));
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it("stops retrying after unmount", () => {
    const { unmount } = renderSSE();

    act(() => FakeEventSource.instances[0].fail(true));
    unmount();
    act(() => void vi.advanceTimersByTime(60_000));

    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
