// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import type { Block, StreamEntry } from "@dispatch/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";

import {
  answered,
  block,
  blockEntry,
  formBody,
  findingBlock,
  findingRecord,
  launchBlock,
  turnEntry,
  questionBody,
  reviewBlock,
} from "@/test-utils/blocks";

import { deriveInbox, isOpenInput, useInbox } from "./use-inbox";

const ROOT = "agt_root";
const CHILD = "agt_child";
const at = (hhmm: string): string => `2026-09-19T${hhmm}:00.000Z`;

function question(id: string, by: string, when: string, done = false) {
  const options = [{ label: "Yes" }, { label: "No" }];
  return blockEntry(
    block({
      id,
      author: { kind: "agent", agentId: by },
      text: `Q ${id}?`,
      body: questionBody(options, done ? { state: answered("Yes") } : {}),
      createdAt: when,
    })
  );
}

function link(id: string, by: string, when: string, url: string) {
  return blockEntry(
    block({
      id,
      author: { kind: "agent", agentId: by },
      body: { kind: "link", data: { url, title: id }, state: null },
      createdAt: when,
    })
  );
}

/** A review with two findings, both open unless `resolved`. */
function reviewOf(
  id: string,
  by: string,
  to: string | null,
  when: string,
  resolved = false,
  extra: { threadId?: string } = {}
) {
  const finding = (fid: string) =>
    findingBlock(
      `${id}-${fid}`,
      { severity: "major", title: fid, body: "" },
      {
        author: { kind: "agent", agentId: by },
        reviewId: id,
        record: findingRecord(resolved ? "fixed" : "open"),
      }
    );
  return reviewBlock({
    id,
    author: { kind: "agent", agentId: by },
    toAgentId: to,
    summary: "s",
    findings: [finding("f1"), finding("f2")],
    createdAt: when,
    ...(extra.threadId
      ? { threadId: extra.threadId, replyTo: extra.threadId }
      : {}),
  });
}

function review(
  id: string,
  by: string,
  to: string | null,
  when: string,
  resolved = false
) {
  return blockEntry(reviewOf(id, by, to, when, resolved));
}

/** A child's launch card in the parent's stream, showing what it posted there. */
function card(id: string, child: string, when: string, shown: Block[]) {
  return blockEntry(
    launchBlock({ id, toAgentId: child, createdAt: when, blocks: shown })
  );
}

describe("deriveInbox reviews", () => {
  it("lists reviews of the page's agent newest first, open ones before resolved", () => {
    const inbox = deriveInbox(
      [
        review("r-old", CHILD, ROOT, at("09:00")),
        review("r-done", CHILD, ROOT, at("09:30"), true),
        review("r-new", CHILD, ROOT, at("10:00")),
        // A review of someone else's work, on a child's page.
        review("r-other", "agt_x", "agt_y", at("10:30")),
      ],
      ROOT,
      ROOT
    );
    // On the root's page the whole stream counts.
    expect(inbox.reviews.map((r) => r.id)).toEqual([
      "r-other",
      "r-new",
      "r-old",
      "r-done",
    ]);
    // On the child's page: only reviews it wrote or received.
    const childInbox = deriveInbox(
      [
        review("r-mine", CHILD, ROOT, at("09:00")),
        review("r-for-me", "agt_x", CHILD, at("09:30")),
        review("r-other", "agt_x", "agt_y", at("10:30")),
      ],
      CHILD,
      ROOT
    );
    expect(childInbox.reviews.map((r) => r.id)).toEqual(["r-for-me", "r-mine"]);
  });

  it("picks up a review a reviewer posted on its launch card", () => {
    const REVIEWER = "agt_reviewer";
    const onCard = reviewOf("r-card", REVIEWER, CHILD, at("09:10"), false, {
      threadId: "card-1",
    });
    const settled = reviewOf(
      "r-card-done",
      REVIEWER,
      CHILD,
      at("09:20"),
      true,
      {
        threadId: "card-2",
      }
    );
    const entries = [
      card("card-1", REVIEWER, at("09:00"), [onCard]),
      card("card-2", REVIEWER, at("09:15"), [settled]),
      review("r-top", CHILD, ROOT, at("09:30")),
    ];
    const inbox = deriveInbox(entries, ROOT, ROOT);
    // Open before resolved, newest first within each.
    expect(inbox.reviews.map((r) => r.id)).toEqual([
      "r-top",
      "r-card",
      "r-card-done",
    ]);
    // Its findings come along, so its standing can be read.
    expect(inbox.reviews[1]!.blocks?.map((b) => b.id)).toEqual([
      "r-card-f1",
      "r-card-f2",
    ]);
    // The reviewed child sees the reviews addressed to it; the launch card
    // itself is no input or link.
    const childInbox = deriveInbox(entries, CHILD, ROOT);
    expect(childInbox.reviews.map((r) => r.id)).toEqual([
      "r-top",
      "r-card",
      "r-card-done",
    ]);
    expect(childInbox.inputs).toEqual([]);
  });
});

describe("isOpenInput", () => {
  it("is an agent's unanswered question or form for people", () => {
    expect(isOpenInput(question("q", ROOT, at("10:00")).block)).toBe(true);
    expect(isOpenInput(question("q", ROOT, at("10:00"), true).block)).toBe(
      false
    );
    const canceled = question("q-canceled", ROOT, at("10:00")).block;
    canceled.state = {
      cancellation: {
        by: { kind: "user" },
        at: "2026-09-22T12:00:00.000Z",
      },
    } as never;
    expect(isOpenInput(canceled)).toBe(false);
    expect(
      isOpenInput(
        block({
          author: { kind: "agent", agentId: ROOT },
          body: formBody([{ id: "f", label: "F", type: "text" }]),
        })
      )
    ).toBe(true);
    // Addressed to another agent: that agent answers, not the user.
    expect(
      isOpenInput({
        ...question("q", ROOT, at("10:00")).block,
        toAgentId: CHILD,
      })
    ).toBe(false);
    expect(isOpenInput(block({ text: "hi" }))).toBe(false);
  });
});

describe("deriveInbox", () => {
  const entries: StreamEntry[] = [
    question("q1", ROOT, at("10:00")),
    question("q2", CHILD, at("10:01")),
    question("q3", ROOT, at("10:02"), true),
    link("l1", ROOT, at("10:03"), "https://example.com/a"),
    link("l2", CHILD, at("10:04"), "https://github.com/o/r/pull/7"),
    link("l3", ROOT, at("10:05"), "https://example.com/a"),
    blockEntry(
      block({
        id: "p1",
        author: { kind: "agent", agentId: ROOT },
        text: "see",
        attachments: [{ type: "pr", url: "https://github.com/o/r/pull/8" }],
        createdAt: at("10:06"),
      })
    ),
  ];

  it("lists every open input in the stream on the root's page, oldest first", () => {
    const inbox = deriveInbox(entries, ROOT, ROOT);
    expect(inbox.inputs.map((b) => b.id)).toEqual(["q1", "q2"]);
  });

  it("lists only the child's own inputs and links on a child's page", () => {
    const inbox = deriveInbox(entries, CHILD, ROOT);
    expect(inbox.inputs.map((b) => b.id)).toEqual(["q2"]);
    expect(inbox.links.map((l) => l.url)).toEqual([
      "https://github.com/o/r/pull/7",
    ]);
    expect(inbox.links[0]?.pr).toBe(true);
  });

  it("adds open asks made in threads from the first page's list, deduped and in order", () => {
    const inThread = (id: string, by: string, when: string, done = false) => ({
      ...question(id, by, when, done).block,
      threadId: "card",
      replyTo: "card",
    });
    const openInputs = [
      // Also a row of the feed: listed once.
      question("q1", ROOT, at("10:00")).block,
      inThread("t1", CHILD, at("09:59")),
      inThread("t2", CHILD, at("10:01")),
      // Answered since the page loaded: not open.
      inThread("t3", CHILD, at("10:02"), true),
    ];
    const inbox = deriveInbox(entries, ROOT, ROOT, openInputs);
    expect(inbox.inputs.map((b) => b.id)).toEqual(["t1", "q1", "q2", "t2"]);
    // On the child's page, only its own asks.
    expect(
      deriveInbox(entries, CHILD, ROOT, openInputs).inputs.map((b) => b.id)
    ).toEqual(["t1", "q2", "t2"]);
    // Another child's ask is not this child's.
    expect(deriveInbox(entries, "agt_other", ROOT, openInputs).inputs).toEqual(
      []
    );
  });

  it("adds links a child posted in its own thread, from the first page's list, in time order", () => {
    const threadLinks = [
      {
        ...link("t9", CHILD, at("10:07"), "https://example.com/child").block,
        threadId: "card",
        replyTo: "card",
      },
      {
        ...link("t8", CHILD, at("10:02"), "https://github.com/o/r/pull/9")
          .block,
        threadId: "card",
        replyTo: "card",
      },
    ];
    const inbox = deriveInbox(entries, ROOT, ROOT, [], threadLinks);
    expect(inbox.links.map((l) => l.url)).toEqual([
      "https://example.com/child",
      "https://github.com/o/r/pull/8",
      "https://example.com/a",
      "https://github.com/o/r/pull/7",
      "https://github.com/o/r/pull/9",
    ]);
    // On the child's page, its own links: the thread's and the feed's.
    expect(
      deriveInbox(entries, CHILD, ROOT, [], threadLinks).links.map((l) => l.url)
    ).toEqual([
      "https://example.com/child",
      "https://github.com/o/r/pull/7",
      "https://github.com/o/r/pull/9",
    ]);
  });

  it("lists links newest first, once per url, marking pull requests", () => {
    const inbox = deriveInbox(entries, ROOT, ROOT);
    expect(inbox.links.map((l) => [l.url, l.pr])).toEqual([
      ["https://github.com/o/r/pull/8", true],
      ["https://example.com/a", false],
      ["https://github.com/o/r/pull/7", true],
    ]);
    // The newest block with a repeated url is the one kept.
    expect(inbox.links[1]?.blockId).toBe("l3");
  });
});

describe("useInbox", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("does not re-render its page when a stream update leaves the Inbox as it was", async () => {
    // Never answers: the seeded cache is what the hook reads.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {}))
    );
    const queryClient = new QueryClient();
    queryClient.setQueryData<Agent[]>(
      ["agents"],
      [{ id: ROOT, parentAgentId: null } as Agent]
    );
    const feed = (entries: StreamEntry[]) => ({
      pageParams: [undefined],
      pages: [{ entries, hasMore: false, nextCursor: null, unreadCount: 0 }],
    });
    // React Query notifies observers on a timer, not synchronously.
    const update = async (entries: StreamEntry[]) =>
      act(async () => {
        queryClient.setQueryData(["stream", ROOT], feed(entries));
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    const turn = (text: string) =>
      turnEntry({ id: "turn_1", streamId: ROOT, text, createdAt: at("10:10") });
    queryClient.setQueryData(
      ["stream", ROOT],
      feed([question("q1", ROOT, at("10:00")), turn("working")])
    );

    let renders = 0;
    const { result } = renderHook(
      () => {
        renders += 1;
        return useInbox(ROOT);
      },
      {
        wrapper: ({ children }: { children: ReactNode }) =>
          createElement(QueryClientProvider, { client: queryClient }, children),
      }
    );
    expect(result.current.inputs.map((b) => b.id)).toEqual(["q1"]);
    const inputs = result.current.inputs;
    const before = renders;

    // A turn moving on: the feed changes, the Inbox does not.
    await update([question("q1", ROOT, at("10:00")), turn("still working")]);
    expect(renders).toBe(before);
    expect(result.current.inputs).toBe(inputs);

    // A new question does move the Inbox.
    await update([
      question("q1", ROOT, at("10:00")),
      turn("still working"),
      question("q2", ROOT, at("10:11")),
    ]);
    expect(result.current.inputs.map((b) => b.id)).toEqual(["q1", "q2"]);
  });

  it("reads the open asks the first page lists", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {}))
    );
    const queryClient = new QueryClient();
    queryClient.setQueryData<Agent[]>(
      ["agents"],
      [{ id: ROOT, parentAgentId: null } as Agent]
    );
    const asked = {
      ...question("t1", CHILD, at("09:00")).block,
      threadId: "card",
      replyTo: "card",
    };
    queryClient.setQueryData(["stream", ROOT], {
      pageParams: [undefined, "c1"],
      pages: [
        {
          entries: [question("q1", ROOT, at("10:00"))],
          hasMore: true,
          nextCursor: "c1",
          unreadCount: 0,
          openInputs: [asked],
        },
        { entries: [], hasMore: false, nextCursor: null, unreadCount: 0 },
      ],
    });
    const { result } = renderHook(() => useInbox(ROOT), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children),
    });
    expect(result.current.inputs.map((b) => b.id)).toEqual(["t1", "q1"]);
  });
});
