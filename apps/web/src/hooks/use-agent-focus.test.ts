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
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const bodies = () =>
    fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body as string));

  it("beats every 15 s; only user-driven beats are active", () => {
    renderHook(() => useAgentFocus("agt_a", "authenticated"));
    expect(bodies()).toEqual([
      expect.objectContaining({
        sessionId: expect.stringMatching(/^ses_/),
        visible: true,
        viewingAgentId: "agt_a",
        active: true,
      }),
    ]);

    vi.advanceTimersByTime(30_000);
    expect(
      bodies()
        .slice(1)
        .map((b) => b.active)
    ).toEqual([false, false]);

    window.dispatchEvent(new Event("focus"));
    expect(bodies().at(-1)?.active).toBe(true);
    window.dispatchEvent(new Event("blur"));
    expect(bodies().at(-1)?.active).toBe(false);
  });

  it("registers no input-event listeners", () => {
    const windowAdd = vi.spyOn(window, "addEventListener");
    const documentAdd = vi.spyOn(document, "addEventListener");
    renderHook(() => useAgentFocus("agt_a", "authenticated"));

    const types = [...windowAdd.mock.calls, ...documentAdd.mock.calls].map(
      ([type]) => type
    );
    expect(new Set(types)).toEqual(
      new Set(["visibilitychange", "focus", "blur"])
    );
  });
});
