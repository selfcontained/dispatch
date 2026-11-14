// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentFocus } from "./use-agent-focus";

describe("useAgentFocus", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const bodies = () =>
    fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body as string));

  it("beats every 15 s with presence and never sends per interaction", () => {
    renderHook(() => useAgentFocus(null, "authenticated"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodies()[0]).toMatchObject({
      visible: true,
      viewingAgentId: null,
      sessionId: expect.stringMatching(/^ses_/),
    });

    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(1_500);
      window.dispatchEvent(new Event("pointermove"));
    }
    // 30 s of constant interaction: only the two interval beats.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("sends one beat on the first interaction after being idle", () => {
    renderHook(() => useAgentFocus("agt_a", "authenticated"));
    vi.advanceTimersByTime(121_000);
    const beforeReturn = fetchMock.mock.calls.length;

    window.dispatchEvent(new Event("pointermove"));
    expect(fetchMock).toHaveBeenCalledTimes(beforeReturn + 1);
    expect(bodies().at(-1)?.idleMs).toBeLessThan(1_000);

    vi.advanceTimersByTime(2_000);
    window.dispatchEvent(new Event("pointermove"));
    expect(fetchMock).toHaveBeenCalledTimes(beforeReturn + 1);
  });
});
