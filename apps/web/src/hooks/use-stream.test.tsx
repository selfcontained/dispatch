// @vitest-environment jsdom
import type {
  StreamThreadResponse,
  Block,
  BlockReaction,
  StreamAnswerResponse,
  StreamEntry,
  StreamFeedResponse,
} from "@dispatch/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));

import {
  answered,
  block,
  blockEntry,
  findingBlock,
  findingRecord,
  formBody,
  launchBlock,
  questionBody,
  reviewBlock,
} from "@/test-utils/blocks";

import {
  appendToNewestPage,
  applyStreamRead,
  bumpReplyCount,
  type FeedCache,
  mapBlock,
  mapShownBlock,
  mergeBlockState,
  optimisticState,
  optimisticUserBlock,
  removeBlock,
  replaceBlock,
  replaceThreadRoot,
  shareFeedByEntryId,
  shareFeedCache,
  showsBlock,
  streamFeedQueryKey,
  syncAcrossStream,
  threadQueryKey,
  updateBlockReactions,
  upsertFeedEntry,
  upsertThreadReply,
  useAnswerQuestion,
  MARK_READ_RETRY_MS,
  useMarkStreamRead,
  useMarkThreadRead,
  usePostBlock,
  useSetBlockState,
  useStreamFeed,
  useSubmitForm,
  useToggleReaction,
} from "./use-stream";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  apiMock.mockReset();
});

function seededClient(entries: StreamEntry[]): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData<FeedCache>(streamFeedQueryKey("agt_1"), {
    pageParams: [undefined],
    pages: [{ entries, hasMore: false, unreadCount: 0, nextCursor: null }],
  });
  return client;
}

function feedBlocks(client: QueryClient): Block[] {
  const cache = client.getQueryData<FeedCache>(streamFeedQueryKey("agt_1"));
  return (cache?.pages[0]?.entries ?? []).flatMap((entry) =>
    entry.type === "block" ? [entry.block] : []
  );
}

describe("useAnswerQuestion", () => {
  it("posts attachments with the answer, marks the question answered, and files the reply in its thread", async () => {
    const question = block({
      id: "q1",
      text: "Which spec?",
      body: questionBody([{ label: "main" }], { allowFreeform: true }),
    });
    const client = seededClient([blockEntry(question)]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const reply = block({
      id: "r1",
      authorKind: "user",
      text: "this one",
      threadId: "q1",
      replyTo: "q1",
      attachments: [{ type: "link", url: "https://example.com/spec" }],
      createdAt: "2026-09-02T10:01:00.000Z",
    });
    const answeredQuestion: Block = {
      ...question,
      // Recording the answer bumps the row's version, as the store does.
      updatedAt: "2026-09-02T10:01:00.000Z",
      ...questionBody([{ label: "main" }], {
        allowFreeform: true,
        state: answered("this one", undefined, "r1"),
      }),
    };
    // The server stores the reply under the id the client minted.
    apiMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const { id } = JSON.parse(init.body) as { id: string };
      return {
        block: answeredQuestion,
        reply: { ...reply, id },
        delivered: null,
      } satisfies StreamAnswerResponse;
    });

    const { result } = renderHook(() => useAnswerQuestion("agt_1"), {
      wrapper,
    });
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.mutateAsync({
        blockId: "q1",
        value: "this one",
        attachments: [{ type: "link", url: "https://example.com/spec" }],
      });
    });
    // The question shows its answer before the server replies; the feed
    // gains no row, since the reply lives in the question's thread.
    await waitFor(() => {
      const first = feedBlocks(client)[0]!;
      expect(first.kind === "question" && first.state.answer?.value).toBe(
        "this one"
      );
    });
    expect(feedBlocks(client)).toHaveLength(1);
    await act(async () => {
      await pending;
    });

    expect(apiMock).toHaveBeenCalledWith(
      "/api/v1/streams/agt_1/blocks/q1/answer",
      {
        method: "POST",
        body: expect.stringMatching(
          /^\{"id":"[0-9a-f-]{36}","value":"this one","attachments":\[\{"type":"link","url":"https:\/\/example.com\/spec"\}\]\}$/
        ),
      }
    );
    const blocks = feedBlocks(client);
    expect(blocks.map((b) => b.id)).toEqual(["q1"]);
    expect(blocks[0]!.state).toEqual(answeredQuestion.state);
    expect(blocks[0]!.replyCount).toBe(1);
    expect(blocks[0]!.lastReplyAt).toBe(reply.createdAt);
    // The thread was never fetched, so there is nothing to file it into.
    expect(client.getQueryData(threadQueryKey("agt_1", "q1"))).toBeUndefined();
  });

  it("leaves attachments out of the body when there are none", async () => {
    const client = seededClient([]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    apiMock.mockResolvedValue({
      block: block({ id: "q1", body: questionBody([{ label: "main" }]) }),
      reply: block({ id: "r1", authorKind: "user", threadId: "q1" }),
      delivered: null,
    } satisfies StreamAnswerResponse);
    const { result } = renderHook(() => useAnswerQuestion("agt_1"), {
      wrapper,
    });
    await act(async () => {
      await result.current.mutateAsync({
        blockId: "q1",
        value: "main",
        label: "main",
        attachments: [],
      });
    });
    expect(apiMock.mock.calls[0]![1].body).toMatch(
      /^\{"id":"[0-9a-f-]{36}","value":"main","label":"main"\}$/
    );
  });
});

describe("useSubmitForm", () => {
  it("shows the submission at once and posts the values to the submit route", async () => {
    const form = block({
      id: "f1",
      text: "Details?",
      body: {
        kind: "form",
        data: { fields: [{ id: "name", label: "Name", type: "text" }] },
        state: {},
      },
    });
    const client = seededClient([blockEntry(form)]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    apiMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const { id } = JSON.parse(init.body) as { id: string };
      const submitted: Block = {
        ...form,
        kind: "form",
        data: { fields: [{ id: "name", label: "Name", type: "text" }] },
        updatedAt: "2026-09-02T10:02:00.000Z",
        state: {
          submission: {
            values: { name: "Ada" },
            by: { kind: "user" },
            blockId: id,
            at: "2026-09-02T10:02:00.000Z",
          },
        },
      };
      return {
        block: submitted,
        reply: block({ id, authorKind: "user", threadId: "f1", replyTo: "f1" }),
        delivered: null,
      } satisfies StreamAnswerResponse;
    });
    const { result } = renderHook(() => useSubmitForm("agt_1"), { wrapper });
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.mutateAsync({
        blockId: "f1",
        values: { name: "Ada" },
      });
    });
    await waitFor(() => {
      const first = feedBlocks(client)[0]!;
      expect(first.kind === "form" && first.state.submission?.values).toEqual({
        name: "Ada",
      });
    });
    await act(async () => {
      await pending;
    });
    expect(apiMock).toHaveBeenCalledWith(
      "/api/v1/streams/agt_1/blocks/f1/submit",
      {
        method: "POST",
        body: expect.stringMatching(
          /^\{"id":"[0-9a-f-]{36}","values":\{"name":"Ada"\}\}$/
        ),
      }
    );
    expect(feedBlocks(client)[0]!.updatedAt).toBe("2026-09-02T10:02:00.000Z");
  });
});

describe("useSetBlockState", () => {
  const f1 = () =>
    findingBlock("f1", { severity: "major", title: "A", body: "" });
  const f2 = () =>
    findingBlock(
      "f2",
      { severity: "nit", title: "B", body: "" },
      { record: findingRecord("fixed") }
    );
  const review = () =>
    reviewBlock({ id: "rv1", summary: "Two things.", findings: [f1(), f2()] });
  const shown = (b: Block | undefined, id: string) =>
    b?.blocks?.find((x) => x.id === id);

  it("resolves a finding its review shows, in the feed and every loaded thread, and patches the finding's state route", async () => {
    const client = seededClient([blockEntry(review())]);
    // The review's page and the finding's own page are both open.
    client.setQueryData<StreamThreadResponse>(threadQueryKey("agt_1", "rv1"), {
      root: review(),
      replies: [],
    });
    client.setQueryData<StreamThreadResponse>(threadQueryKey("agt_1", "f1"), {
      root: f1(),
      replies: [],
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    let respond: (value: unknown) => void = () => undefined;
    apiMock.mockImplementationOnce(
      () => new Promise((resolve) => (respond = resolve))
    );
    const { result } = renderHook(() => useSetBlockState("agt_1"), {
      wrapper,
    });
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.mutateAsync({
        blockId: "f1",
        state: { status: "fixed" },
      });
    });
    await waitFor(() => {
      const state = shown(feedBlocks(client)[0], "f1")?.state as {
        status: string;
        resolution?: string;
        by: unknown;
      };
      expect(state.status).toBe("resolved");
      expect(state.resolution).toBe("fixed");
      expect(state.by).toEqual({ kind: "user" });
    });
    // The other finding is untouched.
    expect(shown(feedBlocks(client)[0], "f2")?.state).toEqual(f2().state);
    const reviewPage = client.getQueryData<StreamThreadResponse>(
      threadQueryKey("agt_1", "rv1")
    )!;
    expect(
      (shown(reviewPage.root, "f1")?.state as { status: string }).status
    ).toBe("resolved");
    const findingPage = client.getQueryData<StreamThreadResponse>(
      threadQueryKey("agt_1", "f1")
    )!;
    expect((findingPage.root.state as { status: string }).status).toBe(
      "resolved"
    );
    expect(apiMock).toHaveBeenCalledWith(
      "/api/v1/streams/agt_1/blocks/f1/state",
      {
        method: "PATCH",
        body: JSON.stringify({ state: { status: "fixed" } }),
      }
    );
    const stored = {
      ...f1(),
      state: findingRecord("fixed", { at: "2026-09-02T11:00:00.000Z" }),
      updatedAt: "2026-09-02T11:00:00.000Z",
    };
    await act(async () => {
      respond({ block: stored });
      await pending;
    });
    expect(shown(feedBlocks(client)[0], "f1")?.updatedAt).toBe(
      "2026-09-02T11:00:00.000Z"
    );
    expect(
      client.getQueryData<StreamThreadResponse>(threadQueryKey("agt_1", "f1"))!
        .root.updatedAt
    ).toBe("2026-09-02T11:00:00.000Z");
    // The review still shows both findings, in order.
    expect(feedBlocks(client)[0]!.blocks?.map((b) => b.id)).toEqual([
      "f1",
      "f2",
    ]);
  });

  it("puts the previous state back and refetches when the patch fails", async () => {
    const client = seededClient([blockEntry(review())]);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    apiMock.mockRejectedValueOnce(new Error("nope"));
    const { result } = renderHook(() => useSetBlockState("agt_1"), {
      wrapper,
    });
    await act(async () => {
      await result.current
        .mutateAsync({ blockId: "f1", state: { status: "fixed" } })
        .catch(() => undefined);
    });
    expect(shown(feedBlocks(client)[0], "f1")?.state).toEqual(f1().state);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: streamFeedQueryKey("agt_1"),
      exact: true,
    });
  });

  it("keeps a thread reply count that arrives while cancellation is saving", async () => {
    const question = block({
      id: "q1",
      body: questionBody([{ label: "Yes" }]),
    });
    const client = seededClient([blockEntry(question)]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    let respond: (value: unknown) => void = () => undefined;
    apiMock.mockImplementationOnce(
      () => new Promise((resolve) => (respond = resolve))
    );
    const { result } = renderHook(() => useSetBlockState("agt_1"), {
      wrapper,
    });
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.mutateAsync({
        blockId: "q1",
        state: { cancellation: true },
      });
    });
    await waitFor(() =>
      expect(feedBlocks(client)[0]!.state).toHaveProperty("cancellation")
    );
    client.setQueryData<FeedCache>(streamFeedQueryKey("agt_1"), (old) =>
      mapBlock(old, "q1", (current) => ({
        ...current,
        replyCount: 1,
        lastReplyAt: "2026-09-02T10:01:00.000Z",
      }))
    );
    await act(async () => {
      respond({ block: { ...question, state: feedBlocks(client)[0]!.state } });
      await pending;
    });
    expect(feedBlocks(client)[0]).toMatchObject({
      replyCount: 1,
      lastReplyAt: "2026-09-02T10:01:00.000Z",
    });
  });

  it("merges a task list's state one level deep", () => {
    expect(
      mergeBlockState(
        { items: { a: "done" }, note: 1 },
        { items: { b: "now" } }
      )
    ).toEqual({ items: { a: "done", b: "now" }, note: 1 });
    expect(mergeBlockState(null, { items: { t1: "done" } })).toEqual({
      items: { t1: "done" },
    });
  });

  it("stamps optimistic cancellation on an ask", () => {
    const question = block({
      id: "q1",
      body: questionBody([{ label: "Yes" }]),
    });
    expect(
      optimisticState(question, { cancellation: " Not needed " }, "T").state
    ).toMatchObject({
      cancellation: {
        by: { kind: "user" },
        at: "T",
        reason: "Not needed",
      },
    });
  });
});

describe("optimisticUserBlock", () => {
  it("makes a hand-written review a review showing no findings yet", () => {
    const placeholder = optimisticUserBlock(
      "id1",
      "agt_1",
      "",
      [],
      null,
      "agt_2",
      {
        summary: "Two things.",
        findings: [{ severity: "minor", title: "A", body: "" }],
      }
    );
    expect(placeholder.kind).toBe("review");
    expect(placeholder.data).toEqual({ summary: "Two things." });
    // Its findings arrive as blocks with the stored row.
    expect(placeholder.state).toEqual({ blocks: [] });
    expect(placeholder.toAgentId).toBe("agt_2");
    expect(optimisticUserBlock("id2", "agt_1", "hi").kind).toBe("text");
  });
});

describe("optimisticState", () => {
  const finding = () =>
    findingBlock("f1", { severity: "minor", title: "A", body: "" });

  it("replaces a finding's record with the one the server will stamp", () => {
    expect(optimisticState(finding(), { status: "fixed" }, "T").state).toEqual({
      status: "resolved",
      resolution: "fixed",
      by: { kind: "user" },
      at: "T",
    });
    expect(
      optimisticState(finding(), { status: "dismissed", note: " Nope " }, "T")
        .state
    ).toEqual({
      status: "resolved",
      resolution: "dismissed",
      note: "Nope",
      by: { kind: "user" },
      at: "T",
    });
    // `resolved` means fixed unless it names a resolution.
    expect(
      optimisticState(finding(), { status: "resolved" }, "T").state
    ).toMatchObject({ status: "resolved", resolution: "fixed" });
    expect(
      optimisticState(
        finding(),
        { status: "resolved", resolution: "dismissed" },
        "T"
      ).state
    ).toMatchObject({ status: "resolved", resolution: "dismissed" });
    // Reopening drops the resolution; a blank note is no note.
    const dismissed = {
      ...finding(),
      state: findingRecord("dismissed", { note: "old" }),
    };
    expect(
      optimisticState(dismissed, { status: "open", note: "  " }, "T").state
    ).toEqual({ status: "open", by: { kind: "user" }, at: "T" });
    expect(
      optimisticState(dismissed, { status: "open", note: "Still broken" }, "T")
        .state
    ).toEqual({
      status: "open",
      note: "Still broken",
      by: { kind: "user" },
      at: "T",
    });
  });

  it("merges anything else into the block's state", () => {
    const tasks = block({
      id: "t1",
      body: {
        kind: "tasks",
        data: { items: [{ id: "a", text: "A" }] },
        state: { items: { a: "todo" } },
      },
    });
    expect(optimisticState(tasks, { items: { b: "now" } }, "T").state).toEqual({
      items: { a: "todo", b: "now" },
    });
  });
});

describe("shown blocks", () => {
  const finding = (id: string) =>
    findingBlock(id, { severity: "minor", title: id, body: "" });
  const card = () =>
    launchBlock({
      id: "card",
      toAgentId: "agt_2",
      blocks: [
        reviewBlock({
          id: "rv1",
          threadId: "card",
          replyTo: "card",
          findings: [finding("f1"), finding("f2")],
        }),
      ],
    });

  it("maps a block at any depth, keeping everything else by identity", () => {
    const host = card();
    const renamed = mapShownBlock(host, "f2", (b) => ({ ...b, text: "new" }));
    expect(renamed).not.toBe(host);
    expect(renamed.blocks![0]!.blocks![1]!.text).toBe("new");
    // The untouched sibling keeps its identity.
    expect(renamed.blocks![0]!.blocks![0]).toBe(host.blocks![0]!.blocks![0]);
    // Nothing matched, or nothing changed: the same object back.
    expect(mapShownBlock(host, "nope", (b) => ({ ...b, text: "x" }))).toBe(
      host
    );
    expect(mapShownBlock(host, "f1", (b) => b)).toBe(host);
    // The block itself.
    expect(mapShownBlock(host, "card", (b) => ({ ...b, text: "c" })).text).toBe(
      "c"
    );
    expect(showsBlock(host, "rv1")).toBe(true);
    expect(showsBlock(host, "f2")).toBe(true);
    expect(showsBlock(host, "card")).toBe(false);
    expect(showsBlock(finding("f1"), "f1")).toBe(false);
  });

  it("mapBlock rewrites a block the feed's row shows, not only the row", () => {
    const other = block({ id: "other" });
    const client = seededClient([blockEntry(card()), blockEntry(other)]);
    const cache = client.getQueryData<FeedCache>(streamFeedQueryKey("agt_1"))!;
    const next = mapBlock(cache, "f1", (b) => ({ ...b, text: "seen" }))!;
    const rows = next.pages[0]!.entries.map((e) => e.block);
    expect(rows[0]!.blocks![0]!.blocks![0]!.text).toBe("seen");
    expect(rows[1]).toBe(other);
    expect(mapBlock(cache, "missing", (b) => ({ ...b, text: "x" }))).toBe(
      cache
    );
  });

  it("files a block the thread's root shows into the root, not the replies", () => {
    const review = reviewBlock({
      id: "rv1",
      findings: [finding("f1"), finding("f2")],
      replyCount: 0,
    });
    const thread: StreamThreadResponse = { root: review, replies: [] };
    const resolved = {
      ...finding("f1"),
      state: findingRecord("fixed"),
      updatedAt: "2026-09-02T11:00:00.000Z",
    };
    const next = upsertThreadReply(thread, resolved)!;
    expect(next.replies).toEqual([]);
    expect(next.root.blocks![0]!.state).toEqual(findingRecord("fixed"));
    expect(next.root.blocks![1]).toBe(review.blocks![1]);
    // The same copy again changes nothing.
    expect(upsertThreadReply(next, resolved)).toBe(next);

    // On a launch card's page, the review's finding is two levels down.
    const page: StreamThreadResponse = { root: card(), replies: [] };
    const deep = upsertThreadReply(page, resolved)!;
    expect(deep.replies).toEqual([]);
    expect(deep.root.blocks![0]!.blocks![0]!.state).toEqual(
      findingRecord("fixed")
    );
    // A republished review without its findings keeps the ones it had.
    const bare = { ...card().blocks![0]!, blocks: undefined, text: "edited" };
    const kept = upsertThreadReply(page, bare)!;
    expect(kept.root.blocks![0]!.text).toBe("edited");
    expect(kept.root.blocks![0]!.blocks!.map((b) => b.id)).toEqual([
      "f1",
      "f2",
    ]);
  });

  it("replaces only the thread rooted at the block", () => {
    const stored = { ...finding("f1"), text: "stored" };
    const own: StreamThreadResponse = { root: finding("f1"), replies: [] };
    expect(replaceThreadRoot(own, stored)!.root).toBe(stored);
    const other: StreamThreadResponse = {
      root: block({ id: "o" }),
      replies: [],
    };
    expect(replaceThreadRoot(other, stored)).toBe(other);
    expect(replaceThreadRoot(undefined, stored)).toBeUndefined();
  });

  it("counts no reply on a host for a block it shows", () => {
    const review = reviewBlock({
      id: "rv1",
      findings: [finding("f1")],
      replyCount: 0,
    });
    const client = seededClient([blockEntry(review)]);
    const cache = client.getQueryData<FeedCache>(streamFeedQueryKey("agt_1"))!;
    const again = {
      ...finding("f1"),
      createdAt: "2026-09-02T12:00:00.000Z",
    };
    expect(bumpReplyCount(cache, again)).toBe(cache);
    // A real reply in the review's thread still counts.
    const reply = block({
      id: "c1",
      authorKind: "user",
      threadId: "rv1",
      replyTo: "rv1",
      createdAt: "2026-09-02T12:00:00.000Z",
    });
    const next = bumpReplyCount(cache, reply)!;
    expect(next.pages[0]!.entries[0]!.block.replyCount).toBe(1);
  });
});

describe("syncAcrossStream", () => {
  const cache = (openInputs?: Block[]): FeedCache => ({
    pageParams: [undefined, "c1"],
    pages: [
      {
        entries: [],
        hasMore: true,
        unreadCount: 0,
        nextCursor: "c1",
        ...(openInputs ? { openInputs } : {}),
      },
      { entries: [], hasMore: false, unreadCount: 0, nextCursor: null },
    ],
  });
  const ask = (state = {}) =>
    block({
      id: "q1",
      threadId: "card",
      replyTo: "card",
      body: questionBody([{ label: "Yes" }], { state }),
    });

  it("adds an agent's open question asked anywhere, replaces it, and drops it once answered", () => {
    const empty = cache();
    const added = syncAcrossStream(empty, ask())!;
    expect(added.pages[0]!.openInputs!.map((b) => b.id)).toEqual(["q1"]);
    // Only the first page carries the list.
    expect(added.pages[1]).toBe(empty.pages[1]);
    const edited = { ...ask(), text: "Still?" };
    const replaced = syncAcrossStream(added, edited)!;
    expect(replaced.pages[0]!.openInputs).toEqual([edited]);
    const gone = syncAcrossStream(replaced, ask(answered("Yes")))!;
    expect(gone.pages[0]!.openInputs).toEqual([]);
    const canceled = syncAcrossStream(
      replaced,
      ask({ cancellation: { by: { kind: "user" }, at: "T" } })
    )!;
    expect(canceled.pages[0]!.openInputs).toEqual([]);
  });

  it("puts a post with a link in a thread at the head of the thread links, and leaves top-level posts to the feed", () => {
    const empty = cache();
    const linked = block({
      id: "p1",
      threadId: "card",
      replyTo: "card",
      text: "PR up",
      attachments: [{ type: "pr", url: "https://github.com/o/r/pull/1" }],
    });
    const added = syncAcrossStream(empty, linked)!;
    expect(added.pages[0]!.threadLinks).toEqual([linked]);
    const older = block({
      id: "p0",
      threadId: "card",
      replyTo: "card",
      attachments: [{ type: "link", url: "https://example.com" }],
    });
    expect(
      syncAcrossStream(added, older)!.pages[0]!.threadLinks!.map((b) => b.id)
    ).toEqual(["p0", "p1"]);
    // A top-level post is a row of the feed already.
    expect(
      syncAcrossStream(empty, { ...linked, threadId: null, replyTo: null })
    ).toBe(empty);
  });

  it("leaves the cache alone for anything that is not an open ask", () => {
    const empty = cache();
    expect(syncAcrossStream(empty, block({ id: "t1" }))).toBe(empty);
    expect(syncAcrossStream(empty, ask(answered("Yes")))).toBe(empty);
    // A question an agent put to another agent is not for people.
    expect(syncAcrossStream(empty, { ...ask(), toAgentId: "agt_2" })).toBe(
      empty
    );
    // A person's post is never an ask.
    expect(
      syncAcrossStream(empty, {
        ...ask(),
        author: { kind: "user" },
      })
    ).toBe(empty);
    // An open form is.
    const form = block({
      id: "form1",
      body: formBody([{ id: "a", label: "A", type: "text" }]),
    });
    expect(syncAcrossStream(empty, form)!.pages[0]!.openInputs).toEqual([form]);
    expect(
      syncAcrossStream(
        cache([form]),
        block({
          id: "form1",
          body: formBody([{ id: "a", label: "A", type: "text" }], {
            submission: { a: "x" },
          }),
        })
      )!.pages[0]!.openInputs
    ).toEqual([]);
    expect(syncAcrossStream(undefined, ask())).toBeUndefined();
  });
});

describe("threads", () => {
  const root = block({
    id: "root",
    replyCount: 1,
    lastReplyAt: "2026-09-02T10:01:00.000Z",
  });
  const reply = (id: string, createdAt: string): Block =>
    block({
      id,
      authorKind: "user",
      threadId: "root",
      replyTo: "root",
      createdAt,
    });

  it("files a reply into a loaded thread by time, replacing a known one in place", () => {
    const first = reply("r1", "2026-09-02T10:01:00.000Z");
    const thread = { root, replies: [first] };
    const earlier = reply("r0", "2026-09-02T10:00:30.000Z");
    expect(
      upsertThreadReply(thread, earlier)!.replies.map((r) => r.id)
    ).toEqual(["r0", "r1"]);
    expect(upsertThreadReply(thread, first)).toBe(thread);
    const edited = { ...first, text: "edited" };
    expect(upsertThreadReply(thread, edited)!.replies[0]!.text).toBe("edited");
    expect(upsertThreadReply(undefined, first)).toBeUndefined();
  });

  it("counts a new reply on the feed's root once, never a republished one", () => {
    const client = seededClient([blockEntry(root)]);
    const cache = client.getQueryData<FeedCache>(streamFeedQueryKey("agt_1"))!;
    const again = reply("r1", "2026-09-02T10:01:00.000Z");
    expect(bumpReplyCount(cache, again)).toBe(cache);
    const newer = reply("r2", "2026-09-02T10:02:00.000Z");
    const next = bumpReplyCount(cache, newer)!;
    const row = next.pages[0]!.entries[0]!;
    expect(row.type === "block" && row.block.replyCount).toBe(2);
    expect(row.type === "block" && row.block.lastReplyAt).toBe(
      "2026-09-02T10:02:00.000Z"
    );
  });

  it("posts a reply into its thread and the root's count, never the feed", async () => {
    const client = seededClient([blockEntry(root)]);
    client.setQueryData(threadQueryKey("agt_1", "root"), {
      root,
      replies: [reply("r1", "2026-09-02T10:01:00.000Z")],
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    apiMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const { id } = JSON.parse(init.body) as { id: string };
      return {
        block: reply(id, "2026-09-02T10:03:00.000Z"),
        delivered: null,
        held: false,
      };
    });
    const { result } = renderHook(() => usePostBlock("agt_1"), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ text: "in thread", replyTo: "root" });
    });
    expect(apiMock).toHaveBeenCalledWith("/api/v1/streams/agt_1/blocks", {
      method: "POST",
      body: expect.stringMatching(
        /^\{"id":"[0-9a-f-]{36}","text":"in thread","replyTo":"root"\}$/
      ),
    });
    const thread = client.getQueryData<{ replies: Block[] }>(
      threadQueryKey("agt_1", "root")
    )!;
    expect(thread.replies.map((r) => r.id)).toEqual([
      "r1",
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    ]);
    expect(feedBlocks(client).map((b) => b.id)).toEqual(["root"]);
    expect(feedBlocks(client)[0]!.replyCount).toBe(2);
  });
});

describe("shareFeedByEntryId", () => {
  function page(
    entries: StreamEntry[],
    extra: Partial<StreamFeedResponse> = {}
  ): StreamFeedResponse {
    return {
      entries,
      hasMore: true,
      unreadCount: 0,
      nextCursor: "c",
      ...extra,
    };
  }
  const share = shareFeedByEntryId;

  it("keeps unchanged entries when a new entry shifts every page boundary", () => {
    const m = (i: number) =>
      blockEntry(
        block({
          id: `m${i}`,
          createdAt: `2026-09-02T10:${String(i).padStart(2, "0")}:00.000Z`,
        })
      );
    // Two pages of two, newest page first; the refetch adds m5 and the
    // oldest entry of each page slides into the next one.
    const prev: FeedCache = {
      pageParams: [undefined, "c1"],
      pages: [page([m(3), m(4)]), page([m(1), m(2)], { nextCursor: null })],
    };
    const next: FeedCache = {
      pageParams: [undefined, "c1"],
      pages: [page([m(4), m(5)]), page([m(2), m(3)], { nextCursor: null })],
    };
    const shared = share(prev, next);
    const byId = (cache: FeedCache) =>
      new Map(cache.pages.flatMap((p) => p.entries.map((e) => [e.id, e])));
    const before = byId(prev);
    const after = byId(shared);
    for (const id of ["m2", "m3", "m4"]) {
      expect(after.get(id)).toBe(before.get(id));
    }
    expect(after.get("m5")).toBe(next.pages[0]!.entries[1]);
    expect(after.has("m1")).toBe(false);
    // Both pages changed content, so both are fresh objects.
    expect(shared.pages[0]).not.toBe(prev.pages[0]);
    expect(shared.pages[1]).not.toBe(prev.pages[1]);
  });

  it("returns the previous cache untouched when nothing changed", () => {
    const a = blockEntry(block({ id: "a" }));
    const prev: FeedCache = { pageParams: [undefined], pages: [page([a])] };
    const next: FeedCache = {
      pageParams: [undefined],
      pages: [page([blockEntry(block({ id: "a" }))])],
    };
    expect(share(prev, next)).toBe(prev);
  });

  it("replaces only the entry that changed and keeps the other page", () => {
    const a = blockEntry(block({ id: "a" }));
    const b = blockEntry(
      block({ id: "b", createdAt: "2026-09-02T09:00:00.000Z" })
    );
    const prev: FeedCache = {
      pageParams: [undefined, "c1"],
      pages: [page([a]), page([b], { nextCursor: null })],
    };
    const edited = blockEntry(
      block({
        id: "a",
        text: "edited",
        updatedAt: "2026-09-02T11:00:00.000Z",
      })
    );
    const next: FeedCache = {
      pageParams: [undefined, "c1"],
      pages: [
        page([edited]),
        page(
          [
            blockEntry(
              block({ id: "b", createdAt: "2026-09-02T09:00:00.000Z" })
            ),
          ],
          { nextCursor: null }
        ),
      ],
    };
    const shared = share(prev, next);
    expect(shared).not.toBe(prev);
    expect(shared.pages[0]!.entries[0]).not.toBe(a);
    expect(
      shared.pages[0]!.entries[0]!.type === "block" &&
        shared.pages[0]!.entries[0]!.block.text
    ).toBe("edited");
    expect(shared.pages[1]).toBe(prev.pages[1]);
  });

  it("tracks page metadata such as the unread count", () => {
    const a = blockEntry(block({ id: "a" }));
    const prev: FeedCache = { pageParams: [undefined], pages: [page([a])] };
    const next: FeedCache = {
      pageParams: [undefined],
      pages: [page([blockEntry(block({ id: "a" }))], { unreadCount: 2 })],
    };
    const shared = share(prev, next);
    expect(shared.pages[0]!.unreadCount).toBe(2);
    expect(shared.pages[0]!.entries).toBe(prev.pages[0]!.entries);
  });

  it("notices any page field changing, not only the ones it knows about", () => {
    const a = blockEntry(block({ id: "a" }));
    const prev: FeedCache = { pageParams: [undefined], pages: [page([a])] };
    const withExtra = (value: string): StreamFeedResponse =>
      ({
        ...page([blockEntry(block({ id: "a" }))]),
        extra: value,
      }) as StreamFeedResponse;
    const shared = share(
      share(prev, { ...prev, pages: [withExtra("one")] }) as FeedCache,
      {
        pageParams: [undefined],
        pages: [withExtra("two")],
      }
    );
    expect((shared.pages[0] as unknown as { extra: string }).extra).toBe("two");
    expect(shared.pages[0]!.entries).toBe(prev.pages[0]!.entries);
  });

  // setQueryData applies structuralSharing too, so the optimistic paths in
  // this module pass through the function; each shape must come out right.
  it("keeps an optimistic append and reuses every other entry", () => {
    const a = blockEntry(block({ id: "a" }));
    const b = blockEntry(block({ id: "b" }));
    const prev: FeedCache = { pageParams: [undefined], pages: [page([a, b])] };
    const optimistic = block({ id: "optimistic-1", text: "sending" });
    const shared = share(prev, appendToNewestPage(prev, optimistic)!);
    expect(shared.pages[0]!.entries.map((e) => e.id)).toEqual([
      "a",
      "b",
      "optimistic-1",
    ]);
    expect(shared.pages[0]!.entries[0]).toBe(a);
    expect(shared.pages[0]!.entries[1]).toBe(b);
    expect(
      shared.pages[0]!.entries[2]!.type === "block" &&
        shared.pages[0]!.entries[2]!.block.text
    ).toBe("sending");
  });

  it("replaces an answered question in place and reuses the rest", () => {
    const qm = block({ id: "q", body: questionBody([{ label: "Yes" }]) });
    const q = blockEntry(qm);
    const other = blockEntry(block({ id: "o" }));
    const prev: FeedCache = {
      pageParams: [undefined],
      pages: [page([q, other])],
    };
    const answeredQ: Block = {
      ...qm,
      updatedAt: "2026-09-02T10:05:00.000Z",
      ...questionBody([{ label: "Yes" }], { state: answered("Yes", "Yes") }),
    };
    const shared = share(prev, replaceBlock(prev, "q", answeredQ)!);
    const first = shared.pages[0]!.entries[0]!;
    const second = shared.pages[0]!.entries[1];
    expect(first).not.toBe(q);
    expect(
      first.type === "block" && first.block.kind === "question"
        ? first.block.state.answer?.value
        : null
    ).toBe("Yes");
    expect(second).toBe(other);
  });

  it("applies the unread patch while keeping the entries array", () => {
    const a = blockEntry(block({ id: "a" }));
    const prev: FeedCache = { pageParams: [undefined], pages: [page([a])] };
    const patched = share(prev, {
      ...prev,
      pages: [{ ...prev.pages[0]!, unreadCount: 3 }],
    });
    expect(patched.pages[0]!.unreadCount).toBe(3);
    expect(patched.pages[0]!.entries).toBe(prev.pages[0]!.entries);
    expect(patched.pages[0]).not.toBe(prev.pages[0]);
  });

  it("falls back to deep sharing when either side is not a feed cache", () => {
    const next: FeedCache = {
      pageParams: [undefined],
      pages: [page([blockEntry(block({ id: "a" }))])],
    };
    // First fetch: nothing to share with yet.
    expect(shareFeedCache(undefined, next)).toBe(next);
    // Not a cache at all: plain deep sharing, never the by-id path.
    const prevPlain = { pages: "nope" };
    expect(shareFeedCache(prevPlain, { pages: "nope" })).toBe(prevPlain);
  });

  it("shares by id through the query's structuralSharing option", async () => {
    const m = (i: number) =>
      blockEntry(
        block({
          id: `m${i}`,
          createdAt: `2026-09-02T10:${String(i).padStart(2, "0")}:00.000Z`,
        })
      );
    apiMock.mockResolvedValueOnce(page([m(1), m(2)], { nextCursor: null }));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useStreamFeed("agt_1"), { wrapper });
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    const before = result.current.entries;
    apiMock.mockResolvedValueOnce(page([m(2), m(3)], { nextCursor: null }));
    await act(async () => {
      await client.refetchQueries({ queryKey: streamFeedQueryKey("agt_1") });
    });
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    expect(result.current.entries[0]).toBe(before[1]);
  });
});

describe("upsertFeedEntry", () => {
  const page = (
    entries: StreamEntry[],
    extra: Partial<StreamFeedResponse> = {}
  ): StreamFeedResponse => ({
    entries,
    hasMore: false,
    unreadCount: 0,
    nextCursor: null,
    ...extra,
  });
  const at = (s: number) =>
    `2026-09-02T10:00:${String(s).padStart(2, "0")}.000Z`;
  /** A person's post at `when`: a row with no unread count of its own. */
  const post = (id: string, when: string): StreamEntry =>
    blockEntry(block({ id, authorKind: "user", text: id, createdAt: when }));

  it("appends a newer entry to the newest page and bumps unread for agent posts", () => {
    const a = blockEntry(block({ id: "a", createdAt: at(1) }));
    const cache: FeedCache = { pageParams: [undefined], pages: [page([a])] };
    const fresh = blockEntry(
      block({ id: "b", createdAt: at(2), readAt: null })
    );
    const result = upsertFeedEntry(cache, fresh);
    expect(result.placed).toBe(true);
    expect(result.cache.pages[0]!.entries).toEqual([a, fresh]);
    expect(result.cache.pages[0]!.entries[0]).toBe(a);
    expect(result.cache.pages[0]!.unreadCount).toBe(1);
    // A user's own post is never unread.
    const own = blockEntry(
      block({ id: "c", authorKind: "user", createdAt: at(3) })
    );
    expect(upsertFeedEntry(result.cache, own).cache.pages[0]!.unreadCount).toBe(
      1
    );
  });

  it("slots an entry in by time when it is not the newest", () => {
    const cache: FeedCache = {
      pageParams: [undefined],
      pages: [page([post("event:1", at(1)), post("event:3", at(3))])],
    };
    const result = upsertFeedEntry(cache, post("event:2", at(2)));
    expect(result.cache.pages[0]!.entries.map((e) => e.id)).toEqual([
      "event:1",
      "event:2",
      "event:3",
    ]);
  });

  it("replaces a known entry in place, keeping identity when nothing changed", () => {
    const q = blockEntry(
      block({ id: "q", body: questionBody([{ label: "Yes" }]), readAt: null })
    );
    const other = post("event:9", at(5));
    const cache: FeedCache = {
      pageParams: [undefined],
      pages: [page([q, other], { unreadCount: 1 })],
    };
    const same = upsertFeedEntry(
      cache,
      blockEntry(
        block({ id: "q", body: questionBody([{ label: "Yes" }]), readAt: null })
      )
    );
    expect(same.cache).toBe(cache);
    const read = blockEntry(
      block({ id: "q", body: questionBody([{ label: "Yes" }]), readAt: at(9) })
    );
    const result = upsertFeedEntry(cache, read);
    expect(result.placed).toBe(true);
    expect(result.cache.pages[0]!.entries[0]).not.toBe(q);
    expect(result.cache.pages[0]!.entries[1]).toBe(other);
    // Read state is the server's to count (`chat.read`); a replacement
    // never moves the number, even when it carries a fresh readAt.
    expect(result.cache.pages[0]!.unreadCount).toBe(1);
  });

  it("replaces a row on an older page without touching the newest page", () => {
    const old = blockEntry(block({ id: "o", createdAt: at(1), text: "v1" }));
    const cache: FeedCache = {
      pageParams: [undefined, "c1"],
      pages: [
        page([post("event:5", at(5))], {
          unreadCount: 1,
          hasMore: true,
          nextCursor: "c1",
        }),
        page([old]),
      ],
    };
    const result = upsertFeedEntry(
      cache,
      blockEntry(block({ id: "o", createdAt: at(1), text: "v2" }))
    );
    const replaced = result.cache.pages[1]!.entries[0]!;
    expect(replaced.type === "block" ? replaced.block.text : null).toBe("v2");
    expect(result.cache.pages[0]).toBe(cache.pages[0]);
  });

  it("refuses an entry older than a head that has pages below it", () => {
    const cache: FeedCache = {
      pageParams: [undefined],
      pages: [
        page([post("event:5", at(5))], { hasMore: true, nextCursor: "c1" }),
      ],
    };
    const result = upsertFeedEntry(cache, post("event:1", at(1)));
    expect(result.placed).toBe(false);
    expect(result.cache).toBe(cache);
    // With the whole history loaded it is simply the oldest row.
    const complete: FeedCache = {
      pageParams: [undefined],
      pages: [page([post("event:5", at(5))])],
    };
    expect(
      upsertFeedEntry(
        complete,
        post("event:1", at(1))
      ).cache.pages[0]!.entries.map((e) => e.id)
    ).toEqual(["event:1", "event:5"]);
  });

  it("leaves a row that shares a millisecond with a cached one to a refetch", () => {
    // The server breaks such ties by microsecond, source and id; the wire
    // carries none of those, so local placement would only be a guess.
    const cache: FeedCache = {
      pageParams: [undefined],
      pages: [page([post("event:1", at(1)), post("event:2", at(2))])],
    };
    const tie = upsertFeedEntry(cache, post("event:3", at(2)));
    expect(tie.placed).toBe(false);
    expect(tie.cache).toBe(cache);
    // Equal to the head's oldest row with pages below: also ambiguous.
    const paged: FeedCache = {
      pageParams: [undefined, "c1"],
      pages: [
        page([post("event:5", at(5))], { hasMore: true, nextCursor: "c1" }),
        page([post("event:1", at(1))]),
      ],
    };
    expect(upsertFeedEntry(paged, post("event:9", at(5))).placed).toBe(false);
  });

  it("has nowhere to put anything in an empty cache", () => {
    expect(
      upsertFeedEntry({ pageParams: [], pages: [] }, post("event:1", at(1)))
        .placed
    ).toBe(false);
  });
});

describe("applyStreamRead", () => {
  it("moves only the count, and only when it moved", () => {
    const a = blockEntry(block({ id: "a" }));
    const cache: FeedCache = {
      pageParams: [undefined],
      pages: [
        { entries: [a], hasMore: false, nextCursor: null, unreadCount: 2 },
      ],
    };
    expect(applyStreamRead(cache, 2)).toBe(cache);
    const next = applyStreamRead(cache, 0)!;
    expect(next.pages[0]!.unreadCount).toBe(0);
    expect(next.pages[0]!.entries).toBe(cache.pages[0]!.entries);
    expect(applyStreamRead(undefined, 0)).toBeUndefined();
  });

  it("stamps the rows a mark-read covered so they agree with the count", () => {
    const t = (s: number) => `2026-09-02T10:00:0${s}.000Z`;
    const early = blockEntry(block({ id: "e", createdAt: t(1), readAt: null }));
    const bound = blockEntry(block({ id: "b", createdAt: t(2), readAt: null }));
    const later = blockEntry(block({ id: "l", createdAt: t(3), readAt: null }));
    const user = blockEntry(
      block({ id: "u", authorKind: "user", createdAt: t(1), readAt: null })
    );
    const cache: FeedCache = {
      pageParams: [undefined, "c1"],
      pages: [
        {
          entries: [bound, later],
          hasMore: true,
          nextCursor: "c1",
          unreadCount: 3,
        },
        {
          entries: [user, early],
          hasMore: false,
          nextCursor: null,
          unreadCount: 0,
        },
      ],
    };
    const next = applyStreamRead(cache, 1, { readAt: t(9), upToAt: t(2) })!;
    const readAt = (e: StreamEntry) =>
      e.type === "block" ? e.block.readAt : "?";
    expect(next.pages[0]!.entries.map(readAt)).toEqual([t(9), null]);
    expect(next.pages[1]!.entries.map(readAt)).toEqual([null, t(9)]);
    expect(next.pages[0]!.entries[1]).toBe(later);
    expect(next.pages[1]!.entries[0]).toBe(user);
    expect(next.pages[0]!.unreadCount).toBe(1);
    const all = applyStreamRead(cache, 0, { readAt: t(9), upToAt: null })!;
    expect(all.pages[0]!.entries.map(readAt)).toEqual([t(9), t(9)]);
    // Already stamped: nothing to do, same object back.
    expect(applyStreamRead(all, 0, { readAt: t(10), upToAt: null })).toBe(all);
  });
});

describe("removeBlock", () => {
  it("drops one message wherever it sits and keeps the rest by identity", () => {
    const a = blockEntry(block({ id: "a" }));
    const b = blockEntry(block({ id: "b" }));
    const cache: FeedCache = {
      pageParams: [undefined, "c1"],
      pages: [
        { entries: [b], hasMore: true, nextCursor: "c1", unreadCount: 0 },
        { entries: [a], hasMore: false, nextCursor: null, unreadCount: 0 },
      ],
    };
    const next = removeBlock(cache, "a")!;
    expect(next.pages[0]).toBe(cache.pages[0]);
    expect(next.pages[1]!.entries).toEqual([]);
    expect(removeBlock(cache, "nope")).toBe(cache);
  });
});

describe("usePostBlock", () => {
  it("moves a post the server filed on a child's card out of the feed and into that thread", async () => {
    const card = launchBlock({ id: "card", toAgentId: "agt_2", replyCount: 0 });
    const client = seededClient([blockEntry(card)]);
    client.setQueryData<StreamThreadResponse>(threadQueryKey("agt_1", "card"), {
      root: card,
      replies: [],
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    let respond: (value: unknown) => void = () => undefined;
    apiMock.mockImplementationOnce(
      () => new Promise((resolve) => (respond = resolve))
    );
    const { result } = renderHook(() => usePostBlock("agt_1"), { wrapper });
    let sent: Promise<unknown> = Promise.resolve();
    act(() => {
      sent = result.current.mutateAsync({ text: "try again", to: "agt_2" });
    });
    // Sent top-level, the placeholder shows in the channel at first.
    await waitFor(() => expect(feedBlocks(client)).toHaveLength(2));
    const id = feedBlocks(client)[1]!.id;
    const body = JSON.parse(
      (apiMock.mock.calls[0]![1] as { body: string }).body
    ) as Record<string, unknown>;
    expect(body).toEqual({ id, text: "try again", to: "agt_2" });
    const stored = block({
      id,
      authorKind: "user",
      toAgentId: "agt_2",
      text: "try again",
      threadId: "card",
      replyTo: "card",
      createdAt: "2026-09-02T10:05:00.000Z",
    });
    await act(async () => {
      respond({ block: stored, delivered: null, held: false });
      await sent;
    });
    // The channel keeps only the card, which counts the reply...
    expect(feedBlocks(client).map((b) => b.id)).toEqual(["card"]);
    expect(feedBlocks(client)[0]!.replyCount).toBe(1);
    // ...and the card's thread holds the post.
    expect(
      client
        .getQueryData<StreamThreadResponse>(threadQueryKey("agt_1", "card"))!
        .replies.map((r) => r.id)
    ).toEqual([id]);
  });

  it("shows one row when the stream delivers the stored message before the response", async () => {
    const client = seededClient([blockEntry(block({ id: "a" }))]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    let respond: (value: unknown) => void = () => undefined;
    apiMock.mockImplementationOnce(
      () => new Promise((resolve) => (respond = resolve))
    );
    const { result } = renderHook(() => usePostBlock("agt_1"), {
      wrapper,
    });
    let sent: Promise<unknown> = Promise.resolve();
    act(() => {
      sent = result.current.mutateAsync({ text: "hi" });
    });
    await waitFor(() => expect(feedBlocks(client)).toHaveLength(2));
    const id = feedBlocks(client)[1]!.id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const stored = block({
      id,
      authorKind: "user",
      text: "hi",
      updatedAt: "2026-09-02T10:00:05.000Z",
    });
    // The stream's copy replaces the placeholder under the same id...
    act(() => {
      client.setQueryData<FeedCache>(streamFeedQueryKey("agt_1"), (old) =>
        old ? upsertFeedEntry(old, blockEntry(stored)).cache : old
      );
    });
    expect(feedBlocks(client).map((m) => m.id)).toEqual(["a", id]);
    const streamed = feedBlocks(client)[1];
    // ...and the same-version response then leaves it alone.
    await act(async () => {
      respond({ block: stored, delivered: null, held: false });
      await sent;
    });
    expect(feedBlocks(client).map((m) => m.id)).toEqual(["a", id]);
    expect(feedBlocks(client)[1]).toBe(streamed);
  });

  it("rolls back only its placeholder when the send fails, keeping a streamed row", async () => {
    const client = seededClient([blockEntry(block({ id: "a" }))]);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    let failSend: (error: Error) => void = () => undefined;
    apiMock.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (failSend = reject))
    );
    const { result } = renderHook(() => usePostBlock("agt_1"), {
      wrapper,
    });
    let sent: Promise<unknown> = Promise.resolve();
    act(() => {
      sent = result.current.mutateAsync({ text: "hi" }).catch(() => undefined);
    });
    await waitFor(() => expect(feedBlocks(client)).toHaveLength(2));
    const placeholderId = feedBlocks(client)[1]!.id;
    // The server did store it under that id, and its chat.entry lands
    // before the (failing) response does: the placeholder is replaced.
    const stored = block({
      id: placeholderId,
      authorKind: "user",
      text: "hi",
      delivered: true,
    });
    act(() => {
      client.setQueryData<FeedCache>(streamFeedQueryKey("agt_1"), (old) =>
        old ? upsertFeedEntry(old, blockEntry(stored)).cache : old
      );
    });
    await act(async () => {
      failSend(new Error("connection lost"));
      await sent;
    });
    expect(feedBlocks(client).map((m) => [m.id, m.delivered])).toEqual([
      ["a", null],
      [placeholderId, true],
    ]);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: streamFeedQueryKey("agt_1"),
      exact: true,
    });
  });
});

describe("replaceBlock", () => {
  it("keeps the cache's copy of a row when the response is the same version", () => {
    // The stream's copy carries what the feed derives (attachment
    // dimensions); the bare response must not overwrite it.
    const streamed = block({
      id: "q",
      body: questionBody([{ label: "Yes" }]),
      updatedAt: "2026-09-02T11:00:00.000Z",
      attachments: [
        {
          type: "file",
          fileId: 1,
          fileName: "a.png",
          sizeBytes: 10,
          mimeType: "image/png",
          width: 640,
          height: 480,
        } as Block["attachments"][number],
      ],
    });
    const cache: FeedCache = {
      pageParams: [undefined],
      pages: [
        {
          entries: [blockEntry(streamed)],
          hasMore: false,
          nextCursor: null,
          unreadCount: 0,
        },
      ],
    };
    const bare = { ...streamed, attachments: [] };
    expect(replaceBlock(cache, "q", bare)).toBe(cache);
    // A newer version does replace it.
    const newer = { ...bare, updatedAt: "2026-09-02T12:00:00.000Z" };
    const next = replaceBlock(cache, "q", newer)!;
    const row = next.pages[0]!.entries[0]!;
    expect(row.type === "block" ? row.block.updatedAt : null).toBe(
      "2026-09-02T12:00:00.000Z"
    );
  });

  it("drops the placeholder when the real row already arrived over the stream", () => {
    const temp = blockEntry(
      block({ id: "optimistic-1", authorKind: "user", text: "hi" })
    );
    const real = block({ id: "real", authorKind: "user", text: "hi" });
    const cache: FeedCache = {
      pageParams: [undefined],
      pages: [
        {
          entries: [temp, blockEntry(real)],
          hasMore: false,
          nextCursor: null,
          unreadCount: 0,
        },
      ],
    };
    const next = replaceBlock(cache, "optimistic-1", real)!;
    expect(next.pages[0]!.entries.map((e) => e.id)).toEqual(["real"]);
    expect(next.pages[0]!.entries[0]).toBe(cache.pages[0]!.entries[1]);
  });
});

describe("updateBlockReactions", () => {
  const thumbs: BlockReaction = {
    id: "r1",
    author: { kind: "user" },
    emoji: "👍",
    delivered: true,
    createdAt: "2026-09-02T10:01:00.000Z",
  };

  it("rewrites one message's reactions and keeps everything else by identity", () => {
    const client = seededClient([
      blockEntry(block({ id: "a" })),
      blockEntry(block({ id: "b" })),
    ]);
    const cache = client.getQueryData<FeedCache>(streamFeedQueryKey("agt_1"))!;
    const next = updateBlockReactions(cache, "b", () => [thumbs])!;
    expect(next.pages[0]!.entries[0]).toBe(cache.pages[0]!.entries[0]);
    const b = next.pages[0]!.entries[1]!;
    expect(b.type === "block" && b.block.reactions).toEqual([thumbs]);
  });

  it("drops the key when the last reaction goes, matching the server's row", () => {
    const client = seededClient([
      blockEntry(block({ id: "a", reactions: [thumbs] })),
    ]);
    const cache = client.getQueryData<FeedCache>(streamFeedQueryKey("agt_1"))!;
    const next = updateBlockReactions(cache, "a", () => [])!;
    const a = next.pages[0]!.entries[0]!;
    expect(a.type === "block" && "reactions" in a.block).toBe(false);
  });

  it("returns the same cache when the update changes nothing", () => {
    const client = seededClient([blockEntry(block({ id: "a" }))]);
    const cache = client.getQueryData<FeedCache>(streamFeedQueryKey("agt_1"))!;
    expect(updateBlockReactions(cache, "a", (r) => r)).toBe(cache);
    expect(updateBlockReactions(cache, "missing", () => [thumbs])).toBe(cache);
  });
});

describe("useToggleReaction", () => {
  function setup(entries: StreamEntry[]) {
    const client = seededClient(entries);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useToggleReaction("agt_1"), {
      wrapper,
    });
    return { client, result };
  }

  const stored = (delivered: boolean | null): BlockReaction => ({
    id: "3f1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5",
    author: { kind: "user" },
    emoji: "🎉",
    delivered,
    createdAt: "2026-09-02T10:01:00.000Z",
  });

  it("shows the chip at once, posts the emoji, then swaps in the stored reaction", async () => {
    const { client, result } = setup([blockEntry(block({ id: "a" }))]);
    let respond: (value: unknown) => void = () => undefined;
    apiMock.mockImplementationOnce(
      () => new Promise((resolve) => (respond = resolve))
    );
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.mutateAsync({
        blockId: "a",
        emoji: "🎉",
        remove: false,
      });
    });
    await waitFor(() =>
      expect(feedBlocks(client)[0]!.reactions).toEqual([
        expect.objectContaining({
          author: { kind: "user" },
          emoji: "🎉",
          delivered: null,
        }),
      ])
    );
    expect(apiMock).toHaveBeenCalledWith(
      "/api/v1/streams/agt_1/blocks/a/reactions",
      { method: "POST", body: JSON.stringify({ emoji: "🎉" }) }
    );
    await act(async () => {
      respond({ blockId: "a", reactions: [stored(null)] });
      await done;
    });
    expect(feedBlocks(client)[0]!.reactions).toEqual([stored(null)]);
  });

  it("never puts a pending response over a delivered reaction the stream already placed", async () => {
    const { client, result } = setup([blockEntry(block({ id: "a" }))]);
    let respond: (value: unknown) => void = () => undefined;
    apiMock.mockImplementationOnce(
      () => new Promise((resolve) => (respond = resolve))
    );
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.mutateAsync({
        blockId: "a",
        emoji: "🎉",
        remove: false,
      });
    });
    await waitFor(() => expect(feedBlocks(client)[0]!.reactions).toBeDefined());
    // Delivery settled and its chat.entry landed before the response.
    act(() => {
      client.setQueryData<FeedCache>(streamFeedQueryKey("agt_1"), (old) =>
        old
          ? upsertFeedEntry(
              old,
              blockEntry(block({ id: "a", reactions: [stored(true)] }))
            ).cache
          : old
      );
    });
    await act(async () => {
      respond({ blockId: "a", reactions: [stored(null)] });
      await done;
    });
    expect(feedBlocks(client)[0]!.reactions).toEqual([stored(true)]);
  });

  it("adds the user's emoji alongside the same emoji from the agent", async () => {
    const agentThumbs: BlockReaction = {
      ...stored(null),
      id: "agent-r",
      author: { kind: "agent", agentId: "agt_1" },
    };
    const { client, result } = setup([
      blockEntry(block({ id: "a", reactions: [agentThumbs] })),
    ]);
    apiMock.mockReturnValueOnce(new Promise(() => undefined));
    act(() => {
      void result.current.mutateAsync({
        blockId: "a",
        emoji: "🎉",
        remove: false,
      });
    });
    await waitFor(() =>
      expect(feedBlocks(client)[0]!.reactions).toEqual([
        agentThumbs,
        expect.objectContaining({ author: { kind: "user" }, emoji: "🎉" }),
      ])
    );
  });

  it("removes the chip at once and deletes by the encoded emoji", async () => {
    const { client, result } = setup([
      blockEntry(block({ id: "a", reactions: [stored(true)] })),
    ]);
    apiMock.mockResolvedValueOnce({ blockId: "a", reactions: [] });
    await act(async () => {
      await result.current.mutateAsync({
        blockId: "a",
        emoji: "🎉",
        remove: true,
      });
    });
    expect(apiMock).toHaveBeenCalledWith(
      `/api/v1/streams/agt_1/blocks/a/reactions/${encodeURIComponent("🎉")}`,
      { method: "DELETE" }
    );
    expect(feedBlocks(client)[0]!.reactions).toBeUndefined();
  });

  it("asks the server again when a toggle fails", async () => {
    const { client, result } = setup([blockEntry(block({ id: "a" }))]);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    apiMock.mockRejectedValueOnce(new Error("agent stopped"));
    await act(async () => {
      await result.current
        .mutateAsync({ blockId: "a", emoji: "👍", remove: false })
        .catch(() => undefined);
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: streamFeedQueryKey("agt_1"),
      exact: true,
    });
  });
});

describe("useMarkThreadRead", () => {
  it("clears the unseen count of the block the thread opens on, where the review shows it", async () => {
    const finding = {
      ...findingBlock("f1", { severity: "major", title: "A", body: "" }),
      replyCount: 1,
      unreadReplies: 1,
    };
    const client = seededClient([
      blockEntry(reviewBlock({ id: "rv1", summary: "S", findings: [finding] })),
    ]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    apiMock.mockResolvedValueOnce({
      ids: ["c1"],
      readAt: "2026-09-02T12:00:00.000Z",
    });
    const { result } = renderHook(() => useMarkThreadRead("agt_1"), {
      wrapper,
    });
    await act(async () => {
      await result.current.mutateAsync({ blockId: "f1" });
    });
    expect(
      feedBlocks(client)[0]!.blocks?.find((b) => b.id === "f1")?.unreadReplies
    ).toBe(0);
  });
});

describe("useMarkStreamRead", () => {
  /** A pane's visibility effect: marks up to its newest agent block. */
  function usePaneMark(upTo: string, unreadCount: number) {
    const markRead = useMarkStreamRead("agt_1", unreadCount);
    useEffect(() => {
      markRead(upTo);
    }, [markRead, upTo]);
    return markRead;
  }

  function wrapperFor(client: QueryClient) {
    return ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }

  it("marks once when the rows left unread are out of its reach, not in a loop", async () => {
    const client = seededClient([]);
    // A turn answering in a thread stays unread: the count does not move.
    apiMock.mockResolvedValue({ unreadCount: 1 });
    const { result, rerender } = renderHook(
      ({ upTo }: { upTo: string }) => usePaneMark(upTo, 1),
      { wrapper: wrapperFor(client), initialProps: { upTo: "b1" } }
    );
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The pane's effect re-runs whenever the request settles, and focus and
    // visibility changes call it too: in the browser that was ~200 marks a
    // second. The same mark at the same count goes once.
    for (let i = 0; i < 3; i += 1) {
      act(() => result.current("b1"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(apiMock).toHaveBeenCalledTimes(1);

    // A newer post for people moves the mark forward.
    rerender({ upTo: "b2" });
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(apiMock.mock.calls[1]![1].body)).toEqual({ upTo: "b2" });
  });

  it("marks again when the count moves, and after a failure only once the pause is over", async () => {
    const client = seededClient([]);
    apiMock.mockRejectedValueOnce(new Error("offline"));
    apiMock.mockResolvedValue({ unreadCount: 0 });
    const { result, rerender } = renderHook(
      ({ count }: { count: number }) => usePaneMark("b1", count),
      { wrapper: wrapperFor(client), initialProps: { count: 2 } }
    );
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The failure settled and re-ran the effect: no immediate retry.
    act(() => result.current("b1"));
    expect(apiMock).toHaveBeenCalledTimes(1);

    const now = Date.now();
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(now + MARK_READ_RETRY_MS + 1);
    act(() => result.current("b1"));
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    clock.mockRestore();

    // Another unread post arrived: the same mark is worth sending again.
    rerender({ count: 3 });
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(3));
  });
});
