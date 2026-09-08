// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { HarnessTurn } from "@dispatch/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { toPromptKitTurns, useHarnessTurns } from "./use-harness-turns";

const api = vi.fn();
vi.mock("@/lib/api", () => ({ api: (...args: unknown[]) => api(...args) }));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => api.mockReset());

const settled: HarnessTurn = {
  id: "turn:1",
  prompt: { source: "chat", text: "look", attachments: [] },
  trace: {
    startedAt: "2026-09-04T10:00:00.000Z",
    endedAt: "2026-09-04T10:00:09.000Z",
    finalResult: "ok",
    steps: [
      {
        id: "stream:2",
        kind: "execute",
        label: "bash",
        status: "ok",
        startedAt: "2026-09-04T10:00:03.000Z",
        endedAt: "2026-09-04T10:00:05.000Z",
        durMs: 2000,
        detail: { terminalOutput: "a\n" },
      },
    ],
  },
  result: { text: "Done.", streaming: false },
};
const live: HarnessTurn = {
  id: "turn:2",
  prompt: {
    source: "agent",
    text: "again",
    senderName: "Reviewer",
    attachments: [
      {
        type: "file",
        mediaId: 7,
        fileName: "shot.png",
        sizeBytes: 10,
        mimeType: "image/png",
      },
      { type: "link", url: "https://x.test/a", title: "A" },
    ],
  },
  trace: {
    startedAt: "2026-09-04T10:00:10.000Z",
    steps: [
      {
        id: "stream:9",
        kind: "read",
        label: "read",
        status: "running",
        startedAt: "2026-09-04T10:00:11.000Z",
        detail: {},
      },
    ],
  },
  result: { text: "Work", streaming: true },
};

describe("toPromptKitTurns", () => {
  it("emits a user and an assistant turn per settled HarnessTurn", () => {
    const out = toPromptKitTurns([settled], "agt_1");
    expect(out.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(out.turns[0].content).toBe("look");
    expect(out.turns[0].extra).toEqual({ source: "chat" });
    expect(out.turns[1].trace?.steps[0]).toMatchObject({
      kind: "execute",
      status: "ok",
      durMs: 2000,
    });
    expect(out.turns[1].trace?.finalResult).toBe("ok");
    // No agent label: the fallback describes the steps.
    expect(out.turns[1].extra?.label).toBe("ran 1 command");
    expect(out.liveTrace).toBeNull();
    expect(out.streaming).toBe(false);
  });

  it("routes a streaming turn through the live path with the sender as a chip", () => {
    const out = toPromptKitTurns([settled, live], "agt_1");
    expect(out.turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
    expect(out.turns[2].contextChips).toEqual([{ label: "from Reviewer" }]);
    expect(out.turns[2].attachments).toEqual([
      {
        kind: "image",
        mediaId: 7,
        url: "/api/v1/agents/agt_1/media/shot.png",
        size: 10,
        at: "2026-09-04T10:00:10.000Z",
        name: "shot.png",
        mimeType: "image/png",
      },
      { kind: "link", url: "https://x.test/a", name: "A" },
    ]);
    expect(out.liveTrace?.steps[0].status).toBe("running");
    expect(out.liveText).toBe("Work");
    expect(out.streaming).toBe(true);
  });

  it("keeps an interrupted turn's final result", () => {
    const out = toPromptKitTurns(
      [{ ...settled, trace: { ...settled.trace, finalResult: "interrupted" } }],
      "agt_1"
    );
    expect(out.turns[1].trace?.finalResult).toBe("interrupted");
    expect(out.turns[1].error).toBeUndefined();
  });

  it("surfaces a failed turn's error on the assistant turn", () => {
    const failed: HarnessTurn = {
      ...settled,
      id: "turn:3",
      trace: { ...settled.trace, finalResult: "error" },
      result: null,
      error: "model exploded",
    };
    const out = toPromptKitTurns([failed], "agt_1");
    expect(out.turns[1].error).toEqual({
      code: "turn_failed",
      message: "model exploded",
    });
    expect(out.turns[1].content).toBe("");
  });
});

describe("toPromptKitTurns: plan, usage, children", () => {
  const nested: HarnessTurn = {
    id: "turn:3",
    prompt: { source: "chat", text: "delegate", attachments: [] },
    trace: {
      startedAt: "2026-09-07T10:00:00.000Z",
      endedAt: "2026-09-07T10:00:09.000Z",
      finalResult: "ok",
      steps: [
        {
          id: "stream:1",
          kind: "other",
          label: "Task",
          status: "ok",
          startedAt: "2026-09-07T10:00:01.000Z",
          endedAt: "2026-09-07T10:00:08.000Z",
          durMs: 7000,
          detail: {},
          children: [
            {
              id: "stream:2",
              kind: "read",
              label: "Read",
              status: "ok",
              startedAt: "2026-09-07T10:00:02.000Z",
              endedAt: "2026-09-07T10:00:03.000Z",
              durMs: 1000,
              detail: {
                locations: [{ path: "a.ts" }],
                parentToolCallId: "task_1",
              },
            },
          ],
        },
      ],
    },
    result: { text: "Done.", streaming: false },
    plan: [{ content: "a", status: "completed", priority: "high" }],
    usage: { used: 4200, size: 200000, costUsd: 0.5 },
  };

  it("keeps children on steps and plan and usage on the assistant turn", () => {
    const { turns, livePlan } = toPromptKitTurns([nested], "agt_1");
    const assistant = turns[1];
    expect(assistant.trace?.steps[0].children?.map((s) => s.label)).toEqual([
      "Read",
    ]);
    expect(assistant.extra?.plan).toEqual([
      { content: "a", status: "completed", priority: "high" },
    ]);
    expect(assistant.extra?.usage).toEqual({
      used: 4200,
      size: 200000,
      costUsd: 0.5,
    });
    expect(livePlan).toBeNull();
  });

  it("exposes the live turn's plan while it is open", () => {
    const open: HarnessTurn = {
      ...nested,
      id: "turn:4",
      trace: { ...nested.trace, endedAt: undefined, finalResult: undefined },
      result: null,
    };
    const { livePlan, streaming } = toPromptKitTurns([open], "agt_1");
    expect(streaming).toBe(true);
    expect(livePlan).toEqual([
      { content: "a", status: "completed", priority: "high" },
    ]);
  });
});

describe("useHarnessTurns", () => {
  it("hands back the same turn model across a rerender with unchanged data", async () => {
    api.mockResolvedValue({ turns: [settled], queued: [] });
    const { result, rerender } = renderHook(() => useHarnessTurns("agt_1"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.turns).toHaveLength(2));
    const { turns, promptHistory } = result.current;
    rerender();
    // ActivityBlock, ResultTurn and PromptLine are all memo()d on these.
    expect(result.current.turns).toBe(turns);
    expect(result.current.promptHistory).toBe(promptHistory);
  });
});
