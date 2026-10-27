// @vitest-environment jsdom
import type { Block, ChatTurnEntry } from "@dispatch/shared";
import { describe, expect, it } from "vitest";

import { block, blockEntry, turnEntry } from "@/test-utils/blocks";

import { visibleFeedEntries } from "./visible-feed";

const at = "2026-09-02T10:00:00.000Z";
const empty = () => turnEntry({ id: "empty", text: " \n\t" });
const project = (entry: ReturnType<typeof empty>) =>
  visibleFeedEntries([entry]);

describe("visibleFeedEntries", () => {
  it("omits only empty successful turns without mutating persisted records", () => {
    const turn = empty();
    const post = blockEntry(block({ text: "" }));
    expect(visibleFeedEntries([turn, post])).toEqual([post]);
    expect(turn.block.turn?.settled).toBe(true);
    expect(turn.block.text).toBe(" \n\t");
  });

  it.each<Partial<ChatTurnEntry>>([
    { settled: false },
    { interrupted: true },
    { interrupted: undefined },
    { error: "failed" },
    { errorKind: "authentication_required" },
    { retry: "open" },
    { retry: "retried" },
    { result: { text: "", streaming: true } },
    { result: { text: "", streaming: false, truncated: true } },
    { result: { text: "late answer", streaming: false } },
    { trace: { startedAt: at, steps: [], finalResult: "error" } },
    { trace: { startedAt: at, steps: [], finalResult: "interrupted" } },
    { trace: { startedAt: at, steps: [] } },
    { trace: { startedAt: at, steps: undefined!, finalResult: "ok" } },
    {
      trace: {
        startedAt: at,
        steps: [],
        finalResult: "ok",
        detailsOmitted: true,
      },
    },
    { plan: [{ content: "Check", status: "completed", priority: "medium" }] },
    { questions: [{ messageId: "question", answered: true }] },
  ])(
    "preserves active, exceptional, actionable and incomplete turns: %j",
    (patch) => {
      const entry = empty();
      Object.assign(entry.block.turn!, patch);
      expect(project(entry)).toEqual([entry]);
    }
  );

  it.each(["", " \n\t"])(
    "uses an authoritative empty result over stale block text: %j",
    (text) => {
      const entry = turnEntry({
        text: "Stale partial answer",
        turn: { result: { text, streaming: false } },
      });
      expect(project(entry)).toEqual([]);
      expect(entry.block.text).toBe("Stale partial answer");
    }
  );

  it("falls back to the stored answer only when the assembled result is absent", () => {
    const entry = turnEntry({ text: "Saved answer", turn: { result: null } });
    expect(project(entry)).toEqual([entry]);
    entry.block.text = " \n";
    expect(project(entry)).toEqual([]);
  });

  it("retains unexpected text-block state rather than assuming it is inert", () => {
    const entry = empty();
    Object.assign(entry.block, { state: { blocks: ["unresolved-task"] } });
    expect(project(entry)).toEqual([entry]);
  });

  it("preserves tool skeletons even when all large details were omitted", () => {
    const entry = empty();
    entry.block.turn!.trace = {
      startedAt: at,
      endedAt: at,
      finalResult: "ok",
      detailsOmitted: true,
      steps: [
        {
          id: "tool",
          kind: "tool",
          label: "Ran checks",
          status: "ok",
          startedAt: at,
          detail: {},
        },
      ],
    };
    expect(project(entry)).toEqual([entry]);
  });

  it.each<Partial<Block>>([
    { kind: "text", data: { responseTo: ["prompt"] }, state: null },
    { kind: "text", data: { scheduledMessageId: "scheduled" }, state: null },
    { attachments: [{ type: "link", url: "https://example.com" }] },
    { blocks: [block({ id: "shown" })] },
    { replyCount: 1 },
    { unreadReplies: 1 },
    { lastReplyAt: at },
    { repliers: [{ kind: "user" }] },
    {
      reactions: [
        {
          id: "reaction",
          delivered: null,
          emoji: "👍",
          author: { kind: "user" },
          createdAt: at,
        },
      ],
    },
    { toAgentId: "recipient" },
    { kind: "tasks" },
  ])("preserves block content and conversation access: %j", (patch) => {
    const entry = empty();
    Object.assign(entry.block, patch);
    expect(project(entry)).toEqual([entry]);
  });

  it("keeps folded ownership across empty settlement and late artifacts", () => {
    const first = turnEntry({ id: "first", text: "", createdAt: at });
    const second = turnEntry({
      id: "second",
      text: "",
      createdAt: "2026-09-02T10:01:00.000Z",
    });
    const artifact = blockEntry(
      block({
        id: "artifact",
        createdAt: second.at,
        text: "",
        attachments: [{ type: "link", url: "https://example.com" }],
      })
    );
    expect(visibleFeedEntries([first, second, artifact])).toEqual([
      second,
      artifact,
    ]);
    expect(visibleFeedEntries([artifact])).toEqual([artifact]); // owner on an older page
  });

  it("recomputes streaming → empty settlement → late answer without stale results", () => {
    const entry = empty();
    entry.block.turn!.settled = false;
    expect(project(entry)).toEqual([entry]);
    entry.block.turn!.settled = true;
    expect(project(entry)).toEqual([]);
    entry.block.turn!.result = { text: "Arrived late", streaming: false };
    expect(project(entry)).toEqual([entry]);
  });
});
