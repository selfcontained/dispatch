// @vitest-environment jsdom
import type { HarnessTurn } from "@dispatch/shared";
import { describe, expect, it } from "vitest";

import { toPromptKitTurns } from "./use-harness-turns";

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
    const out = toPromptKitTurns([settled]);
    expect(out.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(out.turns[0].content).toBe("look");
    expect(out.turns[0].extra).toEqual({ source: "chat" });
    expect(out.turns[1].trace?.steps[0]).toMatchObject({
      kind: "execute",
      status: "ok",
      durMs: 2000,
    });
    expect(out.turns[1].trace?.finalResult).toBe("ok");
    expect(out.liveTrace).toBeNull();
    expect(out.streaming).toBe(false);
  });

  it("routes a streaming turn through the live path with the sender as a chip", () => {
    const out = toPromptKitTurns([settled, live]);
    expect(out.turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
    expect(out.turns[2].contextChips).toEqual([{ label: "from Reviewer" }]);
    expect(out.turns[2].attachments).toEqual([
      {
        kind: "image",
        url: "/api/v1/media/7",
        name: "shot.png",
        mimeType: "image/png",
      },
      { kind: "link", url: "https://x.test/a", name: "A" },
    ]);
    expect(out.liveTrace?.steps[0].status).toBe("running");
    expect(out.liveText).toBe("Work");
    expect(out.streaming).toBe(true);
  });

  it("surfaces a failed turn's error on the assistant turn", () => {
    const failed: HarnessTurn = {
      ...settled,
      id: "turn:3",
      trace: { ...settled.trace, finalResult: "error" },
      result: null,
      error: "model exploded",
    };
    const out = toPromptKitTurns([failed]);
    expect(out.turns[1].error).toEqual({
      code: "turn_failed",
      message: "model exploded",
    });
    expect(out.turns[1].content).toBe("");
  });
});
