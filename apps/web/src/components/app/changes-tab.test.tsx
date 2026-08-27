// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { MemoryRouter, useLocation, useNavigationType } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DiffFile, FileDiffResponse } from "@/hooks/use-agent-diff";
import type { ReviewFeedbackItem } from "@/hooks/use-agent-reviews";
import {
  diffFileTreeOpenAtom,
  diffHideTestFilesAtom,
  diffViewStateAtomFamily,
  diffViewTypeAtom,
  reviewDraftAtomFamily,
} from "@/lib/store";

import { ChangesTab } from "./changes-tab";

// ChangesTab is the orchestration layer between the diff query, the persisted
// per-agent view/review state, the file tree and the diff renderer. The
// renderer itself (UnifiedDiffView + useDiffWidgets) has its own suite, so it
// is replaced here by a stub that (a) records the props routed to it per file
// and (b) reproduces the one piece of react-diff-view DOM this file reaches
// into — the `data-change-key` cells the deep-link line scroll queries for.
// Everything else (DiffPane, FileDiffSection, FileTree, ReviewModeBar) mounts
// for real, because the wiring between them is what is under test.
const { diffViewProps } = vi.hoisted(() => ({
  diffViewProps: new Map<string, Record<string, unknown>>(),
}));

vi.mock("@/lib/api", async () => ({
  ...(await vi.importActual<typeof import("@/lib/api")>("@/lib/api")),
  api: vi.fn(),
}));

// The file sections and the file tree animate open/closed; strip the animation
// layer so collapsed subtrees mount and unmount synchronously in jsdom.
vi.mock("framer-motion", async (importOriginal) => {
  const { createFramerMotionMock } =
    await import("@/test-utils/framer-motion-mock");
  return createFramerMotionMock(importOriginal);
});

vi.mock("@/components/app/unified-diff-view", async () => {
  const React = await import("react");
  const { computeNewLineNumber, getChangeKey, parseDiff } =
    await import("react-diff-view");

  return {
    UnifiedDiffView: (props: Record<string, unknown>) => {
      const filePath = props.filePath as string;
      diffViewProps.set(filePath, props);

      const drafts = (props.draftComments ?? []) as { id: string }[];
      const feedback = (props.feedbackItems ?? []) as { id: number }[];
      const selection = props.lineSelection as {
        filePath: string;
        startLine: number;
      } | null;

      const changes = parseDiff(props.diffText as string, {
        nearbySequences: "zip",
      })[0]?.hunks.flatMap((hunk) => hunk.changes);

      return React.createElement(
        "div",
        {
          "data-testid": `diff-view:${filePath}`,
          "data-view-type": props.viewType,
          "data-diff-text": props.diffText,
          "data-review-mode": String(props.reviewMode ?? false),
          "data-comment-open": String(props.commentOpen),
          "data-drafts": drafts.map((d) => d.id).join(","),
          "data-feedback": feedback.map((f) => f.id).join(","),
          "data-focused-feedback": String(props.focusedFeedbackItemId ?? ""),
          "data-selection": selection
            ? `${selection.filePath}:${selection.startLine}`
            : "",
        },
        React.createElement(
          "table",
          null,
          React.createElement(
            "tbody",
            null,
            (changes ?? []).map((change) => {
              const key = getChangeKey(change);
              return React.createElement(
                "tr",
                { key },
                React.createElement("td", {
                  "data-change-key": key,
                  "data-new-line": String(computeNewLineNumber(change)),
                })
              );
            })
          )
        )
      );
    },
  };
});

const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);

const AGENT_ID = "agent-1";
const OTHER_AGENT_ID = "agent-2";

// New-side line numbers this fixture produces:
//   1 `const a = 1;`    (normal)
//   - `const b = 2;`    (delete — no new-side line)
//   2 `const b = 3;`    (insert)
//   3 `const c = 4;`    (insert)
//   4 `console.log(a);` (normal)
const DIFF = `diff --git a/f b/f
index 1111111..2222222 100644
--- a/f
+++ b/f
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 console.log(a);
`;

function diffFile(path: string, overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    path,
    status: "modified",
    added: 2,
    deleted: 1,
    diff: DIFF,
    truncated: false,
    // The server classifies; this stands in for what it would send. Kept
    // deliberately crude so these tests exercise the tab's use of the flag,
    // not a second copy of the real rule.
    isTest: /\.(?:test|spec)\./.test(path),
    ...overrides,
  };
}

function feedbackItem(id: number, filePath: string): ReviewFeedbackItem {
  return {
    id,
    reviewId: 1,
    filePath,
    lineStart: 2,
    lineEnd: 3,
    diffSnapshot: null,
    baseRef: null,
    status: "open",
    resolution: null,
    resolutionNote: null,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages: [],
  };
}

type ScrollCall = { element: Element; options: unknown };
let scrollCalls: ScrollCall[] = [];

function LocationProbe(): JSX.Element {
  const location = useLocation();
  const navigationType = useNavigationType();
  return (
    <div
      data-testid="location"
      data-search={location.search}
      data-nav-type={navigationType}
    />
  );
}

function renderTab(
  options: {
    files?: DiffFile[];
    feedbackItems?: ReviewFeedbackItem[];
    fileDiff?: FileDiffResponse | Promise<FileDiffResponse>;
    route?: string;
    isMobile?: boolean;
    active?: boolean;
    store?: ReturnType<typeof createStore>;
  } = {}
) {
  const {
    files = [diffFile("src/app.ts")],
    feedbackItems = [],
    fileDiff,
    route = "/",
    isMobile,
    active = true,
    store = createStore(),
  } = options;

  apiMock.mockImplementation((async (path: string) => {
    if (path.includes("/reviews/feedback-items"))
      return { items: feedbackItems };
    if (path.includes("/diff/file")) return await fileDiff;
    if (path.includes("/diff?")) return { baseRef: "main", files };
    throw new Error(`unexpected request: ${path}`);
  }) as typeof api);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onReviewSubmitted = vi.fn();

  const tree = (agentId: string) => (
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>
        <MemoryRouter initialEntries={[route]}>
          <LocationProbe />
          <ChangesTab
            agentId={agentId}
            active={active}
            isMobile={isMobile}
            onReviewSubmitted={onReviewSubmitted}
          />
        </MemoryRouter>
      </Provider>
    </QueryClientProvider>
  );

  const view = render(tree(AGENT_ID));

  return {
    ...view,
    store,
    onReviewSubmitted,
    // The tab is reused across agents rather than remounted per agent, which
    // is what makes the pending-scroll handoff below worth pinning.
    switchAgent: (agentId: string) => view.rerender(tree(agentId)),
  };
}

/** Props most recently routed to the stub renderer for one file. */
function propsFor(filePath: string): Record<string, unknown> {
  const props = diffViewProps.get(filePath);
  if (!props) throw new Error(`no diff view rendered for ${filePath}`);
  return props;
}

function callDiffViewProp(
  filePath: string,
  name: string,
  ...args: unknown[]
): void {
  const handler = propsFor(filePath)[name] as (...a: unknown[]) => void;
  act(() => handler(...args));
}

async function waitForFile(path: string): Promise<void> {
  await screen.findByTestId(`diff-view:${path}`);
}

beforeEach(() => {
  window.localStorage.clear();
  diffViewProps.clear();
  scrollCalls = [];

  // jsdom defines neither of these, so assigning is not spying and
  // vi.restoreAllMocks() would not undo it — both are removed by hand in
  // afterEach so no test in this file can observe a leftover from another.
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: function (this: Element, options: unknown) {
      scrollCalls.push({ element: this, options });
    },
  });
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    writable: true,
    value: {
      escape: (value: string) =>
        value.replace(/[^\w-]/g, (char) => `\\${char}`),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  apiMock.mockReset();
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  Reflect.deleteProperty(globalThis, "CSS");
});

describe("ChangesTab", () => {
  it("fetches nothing while the tab is inactive", async () => {
    renderTab({ active: false });

    await act(async () => {});

    expect(apiMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("diff-view:src/app.ts")).toBeNull();
  });

  it("shows a loading placeholder until the first diff arrives", async () => {
    renderTab();

    expect(screen.getByText("Loading changes…")).toBeTruthy();

    await waitForFile("src/app.ts");
    expect(screen.queryByText("Loading changes…")).toBeNull();
  });

  it("sorts files by path and gives each one only its own drafts and feedback", async () => {
    renderTab({
      files: [diffFile("src/z.ts"), diffFile("src/a.ts")],
      feedbackItems: [
        feedbackItem(11, "src/a.ts"),
        feedbackItem(12, "nope.ts"),
      ],
    });

    await waitForFile("src/a.ts");

    const rendered = screen
      .getAllByTestId(/^changes-file-section:/)
      .map((el) => el.getAttribute("data-testid"));
    expect(rendered).toEqual([
      "changes-file-section:src/a.ts",
      "changes-file-section:src/z.ts",
    ]);

    expect(
      screen.getByTestId("diff-view:src/a.ts").getAttribute("data-feedback")
    ).toBe("11");
    expect(
      screen.getByTestId("diff-view:src/z.ts").getAttribute("data-feedback")
    ).toBe("");
  });

  it("hides test files unless a deep link targets one", async () => {
    const store = createStore();
    store.set(diffHideTestFilesAtom, true);
    const files = [diffFile("src/app.ts"), diffFile("src/app.test.ts")];

    const first = renderTab({ files, store });
    await waitForFile("src/app.ts");
    expect(screen.queryByTestId("diff-view:src/app.test.ts")).toBeNull();
    first.unmount();

    const store2 = createStore();
    store2.set(diffHideTestFilesAtom, true);
    renderTab({ files, store: store2, route: "/?file=src/app.test.ts" });
    await waitForFile("src/app.test.ts");
  });

  it("distinguishes an all-tests diff from an empty diff", async () => {
    const store = createStore();
    store.set(diffHideTestFilesAtom, true);

    const onlyTests = renderTab({
      files: [diffFile("src/app.test.ts")],
      store,
    });
    expect(await screen.findByText("No non-test changes")).toBeTruthy();
    onlyTests.unmount();

    const noneAtAll = renderTab({ files: [] });
    expect(await screen.findByText("No changes yet")).toBeTruthy();
    noneAtAll.unmount();

    // Hiding tests does not change the wording when there was nothing to hide.
    const emptyStore = createStore();
    emptyStore.set(diffHideTestFilesAtom, true);
    renderTab({ files: [], store: emptyStore });
    expect(await screen.findByText("No changes yet")).toBeTruthy();
  });

  it("follows a file deep link, expands the file and replaces the query string", async () => {
    const store = createStore();
    store.set(diffViewStateAtomFamily(AGENT_ID), {
      collapsedFiles: ["src/app.ts"],
      collapsedDirs: [],
      scrollTop: 0,
    });

    renderTab({ store, route: "/?file=src/app.ts" });
    await waitForFile("src/app.ts");

    const section = screen.getByTestId("changes-file-section:src/app.ts");
    await waitFor(() =>
      expect(
        scrollCalls.some(
          (call) =>
            call.element === section &&
            JSON.stringify(call.options) ===
              JSON.stringify({ behavior: "smooth", block: "start" })
        )
      ).toBe(true)
    );

    expect(store.get(diffViewStateAtomFamily(AGENT_ID)).collapsedFiles).toEqual(
      []
    );

    const probe = screen.getByTestId("location");
    expect(probe.getAttribute("data-search")).toBe("");
    expect(probe.getAttribute("data-nav-type")).toBe("REPLACE");
  });

  it("scrolls a line deep link to the matching diff row", async () => {
    renderTab({ route: "/?file=src/app.ts&line=3" });
    await waitForFile("src/app.ts");

    const targetRow = screen
      .getByTestId("diff-view:src/app.ts")
      .querySelector('td[data-new-line="3"]')
      ?.closest("tr");
    expect(targetRow).toBeTruthy();

    await waitFor(() =>
      expect(
        scrollCalls.some(
          (call) =>
            call.element === targetRow &&
            JSON.stringify(call.options) ===
              JSON.stringify({ block: "center", behavior: "smooth" })
        )
      ).toBe(true)
    );
  });

  it("focuses a feedback deep link instead of its line, and ignores a non-numeric id", async () => {
    const focused = renderTab({
      feedbackItems: [feedbackItem(7, "src/app.ts")],
      route: "/?file=src/app.ts&line=3&feedback=7",
    });
    await waitForFile("src/app.ts");

    await waitFor(() =>
      expect(
        screen
          .getByTestId("diff-view:src/app.ts")
          .getAttribute("data-focused-feedback")
      ).toBe("7")
    );
    // A feedback link hands the scroll to the renderer, so the line target is
    // ignored. Let both animation frames of the nav effect run before claiming
    // the line scroll never happened.
    await waitFor(() =>
      expect(
        scrollCalls.some(
          (call) =>
            (call.options as { block?: string } | null)?.block === "start"
        )
      ).toBe(true)
    );
    await act(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    expect(
      scrollCalls.some(
        (call) =>
          (call.options as { block?: string } | null)?.block === "center"
      )
    ).toBe(false);

    // A late completion for an item that is no longer focused is ignored...
    callDiffViewProp("src/app.ts", "onFeedbackFocusComplete", 999);
    expect(
      screen
        .getByTestId("diff-view:src/app.ts")
        .getAttribute("data-focused-feedback")
    ).toBe("7");

    // ...and the focus is cleared once the focused item reports it landed.
    callDiffViewProp("src/app.ts", "onFeedbackFocusComplete", 7);
    expect(
      screen
        .getByTestId("diff-view:src/app.ts")
        .getAttribute("data-focused-feedback")
    ).toBe("");
    focused.unmount();

    renderTab({ route: "/?file=src/app.ts&feedback=not-a-number" });
    await waitForFile("src/app.ts");
    await waitFor(() =>
      expect(screen.getByTestId("location").getAttribute("data-search")).toBe(
        ""
      )
    );
    expect(
      screen
        .getByTestId("diff-view:src/app.ts")
        .getAttribute("data-focused-feedback")
    ).toBe("");
  });

  it("forces the unified view and closes the file tree on mobile", async () => {
    const mobileStore = createStore();
    mobileStore.set(diffViewTypeAtom, "split");

    const mobile = renderTab({
      store: mobileStore,
      isMobile: true,
      route: "/?file=src/app.ts",
    });
    await waitForFile("src/app.ts");
    expect(
      screen.getByTestId("diff-view:src/app.ts").getAttribute("data-view-type")
    ).toBe("unified");
    await waitFor(() =>
      expect(mobileStore.get(diffFileTreeOpenAtom)).toBe(false)
    );
    mobile.unmount();

    const desktopStore = createStore();
    desktopStore.set(diffViewTypeAtom, "split");
    renderTab({ store: desktopStore, route: "/?file=src/app.ts" });
    await waitForFile("src/app.ts");
    expect(
      screen.getByTestId("diff-view:src/app.ts").getAttribute("data-view-type")
    ).toBe("split");
    // Settle on the nav effect having run — it is what would close the tree.
    await waitFor(() =>
      expect(screen.getByTestId("location").getAttribute("data-search")).toBe(
        ""
      )
    );
    expect(desktopStore.get(diffFileTreeOpenAtom)).toBe(true);
  });

  it("routes a line selection to its own file only and closes the comment box", async () => {
    renderTab({ files: [diffFile("src/app.ts"), diffFile("src/util.ts")] });
    await waitForFile("src/util.ts");

    callDiffViewProp("src/app.ts", "onCommentOpen", true);
    expect(
      screen
        .getByTestId("diff-view:src/util.ts")
        .getAttribute("data-comment-open")
    ).toBe("true");

    callDiffViewProp("src/app.ts", "onLineSelection", {
      filePath: "src/app.ts",
      startLine: 2,
      endLine: 3,
    });

    expect(
      screen.getByTestId("diff-view:src/app.ts").getAttribute("data-selection")
    ).toBe("src/app.ts:2");
    expect(
      screen.getByTestId("diff-view:src/util.ts").getAttribute("data-selection")
    ).toBe("");
    expect(
      screen
        .getByTestId("diff-view:src/app.ts")
        .getAttribute("data-comment-open")
    ).toBe("false");
  });

  it("keeps review drafts per file and leaves review mode when the last one goes", async () => {
    const store = createStore();
    renderTab({
      files: [diffFile("src/app.ts"), diffFile("src/util.ts")],
      store,
    });
    await waitForFile("src/util.ts");

    expect(screen.queryByText("Review Mode")).toBeNull();
    callDiffViewProp("src/app.ts", "onStartReview");
    expect(screen.getByText("Review Mode")).toBeTruthy();
    expect(screen.getByText("0 comments")).toBeTruthy();

    callDiffViewProp("src/app.ts", "onAddDraft", "src/app.ts", 2, 3, "first");
    callDiffViewProp(
      "src/util.ts",
      "onAddDraft",
      "src/util.ts",
      1,
      1,
      "second"
    );

    expect(screen.getByText("2 comments")).toBeTruthy();
    expect(
      screen.getByTestId("diff-view:src/app.ts").getAttribute("data-drafts")
    ).toBe("draft-0");
    expect(
      screen.getByTestId("diff-view:src/util.ts").getAttribute("data-drafts")
    ).toBe("draft-1");

    callDiffViewProp("src/app.ts", "onUpdateDraft", "draft-0", "edited");
    expect(store.get(reviewDraftAtomFamily(AGENT_ID)).drafts).toEqual([
      {
        id: "draft-0",
        filePath: "src/app.ts",
        startLine: 2,
        endLine: 3,
        comment: "edited",
      },
      {
        id: "draft-1",
        filePath: "src/util.ts",
        startLine: 1,
        endLine: 1,
        comment: "second",
      },
    ]);
    expect(
      JSON.parse(
        window.localStorage.getItem(`dispatch:review-drafts:${AGENT_ID}`) ??
          "{}"
      ).drafts
    ).toHaveLength(2);

    callDiffViewProp("src/app.ts", "onRemoveDraft", "draft-0");
    expect(screen.getByText("1 comment")).toBeTruthy();

    callDiffViewProp("src/util.ts", "onRemoveDraft", "draft-1");
    expect(screen.queryByText("Review Mode")).toBeNull();
    expect(store.get(reviewDraftAtomFamily(AGENT_ID)).reviewMode).toBe(false);
  });

  it("discards every draft when the review is cancelled", async () => {
    const store = createStore();
    renderTab({ store });
    await waitForFile("src/app.ts");

    callDiffViewProp("src/app.ts", "onStartReview");
    callDiffViewProp("src/app.ts", "onAddDraft", "src/app.ts", 2, 3, "first");
    expect(screen.getByText("1 comment")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel review" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));

    expect(screen.queryByText("Review Mode")).toBeNull();
    expect(store.get(reviewDraftAtomFamily(AGENT_ID))).toEqual({
      reviewMode: false,
      drafts: [],
      nextId: 0,
    });
  });

  it("persists a collapsed file and a collapsed directory", async () => {
    const store = createStore();
    renderTab({
      files: [diffFile("src/app.ts"), diffFile("lib/util.ts")],
      store,
    });
    await waitForFile("src/app.ts");

    fireEvent.click(screen.getByRole("button", { name: /src\/app\.ts/ }));
    expect(screen.queryByTestId("diff-view:src/app.ts")).toBeNull();
    expect(store.get(diffViewStateAtomFamily(AGENT_ID)).collapsedFiles).toEqual(
      ["src/app.ts"]
    );

    fireEvent.click(screen.getByRole("button", { name: /src\/app\.ts/ }));
    expect(screen.getByTestId("diff-view:src/app.ts")).toBeTruthy();
    expect(store.get(diffViewStateAtomFamily(AGENT_ID)).collapsedFiles).toEqual(
      []
    );

    fireEvent.click(screen.getByTitle("src"));
    expect(store.get(diffViewStateAtomFamily(AGENT_ID)).collapsedDirs).toEqual([
      "src",
    ]);
  });

  it("persists the scroll position after the debounce and on unmount", async () => {
    const store = createStore();
    const view = renderTab({ store });
    await waitForFile("src/app.ts");

    vi.useFakeTimers();
    const pane = screen.getByTestId("changes-diff-pane");
    pane.scrollTop = 120;
    fireEvent.scroll(pane);

    act(() => void vi.advanceTimersByTime(299));
    expect(store.get(diffViewStateAtomFamily(AGENT_ID)).scrollTop).toBe(0);
    act(() => void vi.advanceTimersByTime(1));
    expect(store.get(diffViewStateAtomFamily(AGENT_ID)).scrollTop).toBe(120);

    // A scroll still inside the debounce window is flushed by the unmount.
    pane.scrollTop = 400;
    fireEvent.scroll(pane);
    act(() => void vi.advanceTimersByTime(100));
    view.unmount();
    expect(store.get(diffViewStateAtomFamily(AGENT_ID)).scrollTop).toBe(400);
  });

  it("never replays one agent's pending scroll onto the next", async () => {
    const store = createStore();
    store.set(diffViewStateAtomFamily(OTHER_AGENT_ID), {
      collapsedFiles: [],
      collapsedDirs: [],
      scrollTop: 42,
    });
    const view = renderTab({ store });
    await waitForFile("src/app.ts");

    vi.useFakeTimers();
    const pane = screen.getByTestId("changes-diff-pane");
    pane.scrollTop = 999;
    fireEvent.scroll(pane);
    act(() => void vi.advanceTimersByTime(100));

    // Switching agents inside the debounce window flushes the offset to the
    // agent it was measured on, and disarms the pending write for the next.
    act(() => view.switchAgent(OTHER_AGENT_ID));
    expect(store.get(diffViewStateAtomFamily(AGENT_ID)).scrollTop).toBe(999);

    act(() => void vi.advanceTimersByTime(1000));
    view.unmount();
    expect(store.get(diffViewStateAtomFamily(OTHER_AGENT_ID)).scrollTop).toBe(
      42
    );
  });

  it("restores the persisted scroll position once the diff arrives", async () => {
    const store = createStore();
    store.set(diffViewStateAtomFamily(AGENT_ID), {
      collapsedFiles: [],
      collapsedDirs: [],
      scrollTop: 250,
    });

    renderTab({ store });
    await waitForFile("src/app.ts");

    expect(screen.getByTestId("changes-diff-pane").scrollTop).toBe(250);
  });
});

describe("ChangesTab file diff content", () => {
  it("defers a truncated file until it is explicitly loaded", async () => {
    let resolveFileDiff: (value: FileDiffResponse) => void = () => {};
    const pending = new Promise<FileDiffResponse>((resolve) => {
      resolveFileDiff = resolve;
    });

    renderTab({
      files: [
        diffFile("src/large.ts", { diff: null, truncated: true, added: 900 }),
      ],
      fileDiff: pending,
    });

    expect(
      await screen.findByText("Large file (+900 −1) — diff truncated")
    ).toBeTruthy();
    expect(screen.queryByTestId("diff-view:src/large.ts")).toBeNull();
    expect(
      apiMock.mock.calls.some(([path]) => String(path).includes("/diff/file"))
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Load diff" }));
    expect(await screen.findByText("Loading…")).toBeTruthy();

    const fileRequest = apiMock.mock.calls
      .map(([path]) => String(path))
      .find((path) => path.includes("/diff/file"));
    expect(fileRequest).toContain("path=src%2Flarge.ts");
    expect(fileRequest).toContain("force=true");

    resolveFileDiff({
      path: "src/large.ts",
      status: "modified",
      added: 900,
      deleted: 1,
      diff: DIFF,
    });

    const rendered = await screen.findByTestId("diff-view:src/large.ts");
    expect(rendered.getAttribute("data-diff-text")).toBe(DIFF);
  });

  it("explains a missing textual diff differently for deletions and binaries", async () => {
    renderTab({
      files: [
        diffFile("src/gone.ts", { status: "deleted", diff: null }),
        diffFile("logo.png", { diff: null }),
      ],
    });

    await screen.findByTestId("changes-file-section:src/gone.ts");
    expect(
      within(screen.getByTestId("changes-file-section:src/gone.ts")).getByText(
        "File deleted"
      )
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("changes-file-section:logo.png")).getByText(
        "Binary file or no textual diff available"
      )
    ).toBeTruthy();
  });
});
