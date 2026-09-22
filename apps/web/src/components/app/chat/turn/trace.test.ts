// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { ChatTurnStep } from "@dispatch/shared";

import { type FeedCache, shareFeedCache } from "@/hooks/use-stream";
import { turnEntry } from "@/test-utils/blocks";

import { turnTrace } from "./trace";

function step(i: number, status: ChatTurnStep["status"] = "ok"): ChatTurnStep {
  return {
    id: `s${i}`,
    kind: "execute",
    label: `step ${i}`,
    status,
    startedAt: "2026-09-02T10:00:00.000Z",
    detail: { terminalOutput: `out ${i}` },
  };
}

function feedWith(steps: ChatTurnStep[]): FeedCache {
  const entry = turnEntry({
    id: "turn_1",
    turn: {
      settled: false,
      trace: { startedAt: "2026-09-02T10:00:00.000Z", steps },
    },
  });
  return {
    pageParams: [undefined],
    pages: [
      { entries: [entry], hasMore: false, nextCursor: null, unreadCount: 0 },
    ],
  } as unknown as FeedCache;
}

function traceOf(cache: FeedCache) {
  const entry = cache.pages[0]!.entries[0]!;
  return turnTrace(entry.block.turn!);
}

describe("turnTrace", () => {
  it("keeps each unchanged step's identity across a stream update", () => {
    const before = feedWith([step(0), step(1, "running")]);
    // The next event is a fresh parse: every object is new, one step moved.
    const after = shareFeedCache(
      before,
      feedWith([step(0), step(1), step(2, "running")])
    ) as FeedCache;

    const [a0, a1] = traceOf(before).steps;
    const [b0, b1, b2] = traceOf(after).steps;
    expect(b0).toBe(a0);
    expect(b1).not.toBe(a1);
    expect(b1!.status).toBe("ok");
    expect(b2!.status).toBe("running");
  });
});
