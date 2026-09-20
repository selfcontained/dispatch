// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type DraftComment } from "@/components/app/review-mode";
import type { DiffFinding } from "@/components/app/diff-review-annotation-props";
import { block, reviewBody } from "@/test-utils/blocks";

import { UnifiedDiffView } from "./unified-diff-view";

// The view is mounted with its real children (react-diff-view, useDiffWidgets
// and the three inline annotation components) because the contract under test
// is *where* each widget lands: useDiffWidgets keys widgets by change key, and
// react-diff-view is what turns those keys back into rows. Stubbing either side
// would let a mis-keyed widget keep the suite green.
vi.mock("@/lib/api", async () => ({
  ...(await vi.importActual<typeof import("@/lib/api")>("@/lib/api")),
  api: vi.fn(),
}));

// The draft annotation animates; strip the animation layer so it mounts
// synchronously in jsdom.
vi.mock("framer-motion", async (importOriginal) => {
  const { createFramerMotionMock } =
    await import("@/test-utils/framer-motion-mock");
  return createFramerMotionMock(importOriginal);
});

const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);

// New-side line numbers this fixture produces, which every anchor assertion
// below is expressed in:
//   1 `const a = 1;`   (normal)
//   - `const b = 2;`   (delete — no new-side line, never an anchor)
//   2 `const b = 3;`   (insert)
//   3 `const c = 4;`   (insert)
//   4 `console.log(a);`(normal)
//   5 `console.log(b);`(normal)
const DIFF = `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,4 +1,5 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 console.log(a);
 console.log(b);
`;

const FILE_PATH = "src/example.ts";

function draft(overrides: Partial<DraftComment> = {}): DraftComment {
  return {
    id: "draft-1",
    filePath: FILE_PATH,
    startLine: 2,
    endLine: 3,
    comment: "draft body 1",
    ...overrides,
  };
}

type ViewProps = Parameters<typeof UnifiedDiffView>[0];

function renderView(overrides: Partial<ViewProps> = {}) {
  const onLineSelection = vi.fn();
  const onCommentOpen = vi.fn();
  const onAddDraft = vi.fn();
  const onRemoveDraft = vi.fn();
  const onUpdateDraft = vi.fn();
  const onStartReview = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  const { container } = render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <UnifiedDiffView
          agentId="agt_1"
          diffText={DIFF}
          filePath={FILE_PATH}
          lineSelection={null}
          onLineSelection={onLineSelection}
          commentOpen={false}
          onCommentOpen={onCommentOpen}
          viewType="unified"
          onAddDraft={onAddDraft}
          onRemoveDraft={onRemoveDraft}
          onUpdateDraft={onUpdateDraft}
          onStartReview={onStartReview}
          {...overrides}
        />
      </QueryClientProvider>
    </MemoryRouter>
  );

  return {
    container,
    onLineSelection,
    onCommentOpen,
    onAddDraft,
    onRemoveDraft,
    onUpdateDraft,
    onStartReview,
  };
}

/** The `<tr>` rendering the diff line whose code cell contains `code`. */
function rowFor(container: HTMLElement, code: string): HTMLTableRowElement {
  const cell = Array.from(container.querySelectorAll("td.diff-code")).find(
    (td) => td.textContent?.includes(code)
  );
  if (!cell) throw new Error(`no diff row rendering ${JSON.stringify(code)}`);
  const row = cell.closest("tr");
  if (!row) throw new Error(`diff cell for ${code} is not inside a row`);
  return row as HTMLTableRowElement;
}

/**
 * The widget row react-diff-view renders directly beneath a given code line.
 *
 * The strict adjacency is the point, not an accident: "this annotation is
 * anchored to this line" is exactly what useDiffWidgets' change-key mapping is
 * responsible for, and immediate succession is how react-diff-view expresses
 * it. Searching a window of nearby rows instead would let a widget anchored one
 * line off still satisfy every assertion below.
 */
function widgetAfter(container: HTMLElement, code: string): HTMLElement {
  const next = rowFor(container, code).nextElementSibling;
  if (!next?.classList.contains("diff-widget")) {
    throw new Error(`no widget anchored to ${JSON.stringify(code)}`);
  }
  return next as HTMLElement;
}

function widgetRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll("tr.diff-widget"));
}

function clickGutter(
  container: HTMLElement,
  code: string,
  init: MouseEventInit = {}
): void {
  const gutter = rowFor(container, code).querySelector("td.diff-gutter");
  if (!gutter) throw new Error(`no gutter on the row for ${code}`);
  fireEvent.click(gutter, init);
}

/**
 * The floating "add a comment" affordance. The view renders it outside the diff
 * table, so it is the only button that is a direct child of the view root. If
 * that ever stops being unique this throws rather than silently returning the
 * wrong button and turning these assertions into false negatives.
 */
function commentButton(container: HTMLElement): HTMLElement | null {
  const buttons = Array.from(
    container.querySelectorAll<HTMLElement>(".changes-diff-view > button")
  );
  if (buttons.length > 1) {
    throw new Error(
      `expected at most one floating affordance, found ${buttons.length}`
    );
  }
  return buttons[0] ?? null;
}

// jsdom does not implement scrollIntoView at all, so there is no property for
// vi.spyOn to wrap — it has to be assigned. Capture whatever was there first so
// afterEach can put the prototype back exactly as it was found.
const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollIntoView"
);

beforeEach(() => {
  apiMock.mockReset();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  if (originalScrollIntoView) {
    Object.defineProperty(
      Element.prototype,
      "scrollIntoView",
      originalScrollIntoView
    );
  } else {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("UnifiedDiffView", () => {
  // parseDiff always yields one (hunk-less) file even for junk input, so the
  // view's "Unable to parse diff" branch only fires if parseDiff throws. What
  // an unparseable payload actually produces is an empty table — pinned here so
  // a future change to either branch is visible.
  it("renders an empty diff for an unparseable payload", () => {
    const { container } = renderView({ diffText: "not a diff at all" });

    expect(container.querySelector("table.diff")).not.toBeNull();
    expect(container.querySelector("td.diff-code")).toBeNull();
    expect(widgetRows(container)).toHaveLength(0);
  });

  it("renders every change in the hunk", () => {
    const { container } = renderView();

    for (const code of [
      "const a = 1;",
      "const b = 2;",
      "const b = 3;",
      "const c = 4;",
      "console.log(a);",
      "console.log(b);",
    ]) {
      expect(rowFor(container, code)).toBeTruthy();
    }
    expect(widgetRows(container)).toHaveLength(0);
  });
});

// A file with two hunks: without a separator the gutter jumps 6 -> 40 with
// nothing to mark the gap, which is exactly what the separator row exists to
// make visible.
const TWO_HUNK_DIFF = `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,4 +1,5 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 console.log(a);
 console.log(b);
@@ -40,3 +41,3 @@ export function tail() {
 const x = 1;
-const y = 2;
+const y = 3;
`;

// Same shape as TWO_HUNK_DIFF but with nothing trailing the second `@@`, which
// is what git emits when its funcname heuristic finds no enclosing declaration.
const NO_FUNCNAME_DIFF = TWO_HUNK_DIFF.replace(
  "@@ -40,3 +41,3 @@ export function tail() {",
  "@@ -40,3 +41,3 @@"
);

describe("UnifiedDiffView hunk separators", () => {
  it("marks the boundary between hunks but not the top of the file", () => {
    const { container } = renderView({ diffText: TWO_HUNK_DIFF });

    const separators = container.querySelectorAll(".diff-hunk-separator");
    expect(separators).toHaveLength(1);
    expect(separators[0]!.textContent).toContain("@@ -40,3 +41,3 @@");
    expect(separators[0]!.textContent).toContain("export function tail()");
  });

  it("places the separator between the two hunks' rows", () => {
    const { container } = renderView({ diffText: TWO_HUNK_DIFF });

    const bodies = Array.from(container.querySelectorAll("table.diff tbody"));
    const separatorIndex = bodies.findIndex((el) =>
      el.classList.contains("diff-hunk-separator")
    );
    const lastFirstHunkRow = rowFor(container, "console.log(b);");
    const firstSecondHunkRow = rowFor(container, "const x = 1;");

    expect(bodies.indexOf(lastFirstHunkRow.closest("tbody")!)).toBeLessThan(
      separatorIndex
    );
    expect(
      bodies.indexOf(firstSecondHunkRow.closest("tbody")!)
    ).toBeGreaterThan(separatorIndex);
  });

  // Decoration was chosen precisely because it emits a different cell shape per
  // view type; without this the split layout could break silently.
  it("spans the split view's columns", () => {
    const { container } = renderView({
      diffText: TWO_HUNK_DIFF,
      viewType: "split",
    });

    const cells = container.querySelectorAll(".diff-hunk-separator td");
    expect(cells).toHaveLength(2);
    expect(cells[1]!.getAttribute("colspan")).toBe("3");
  });

  it("omits the context span for a header git gave no funcname", () => {
    const { container } = renderView({ diffText: NO_FUNCNAME_DIFF });

    const separator = container.querySelector(".diff-hunk-separator")!;
    expect(separator.textContent).toContain("@@ -40,3 +41,3 @@");
    expect(separator.querySelector(".diff-hunk-separator-context")).toBeNull();
  });
});

describe("UnifiedDiffView draft annotations", () => {
  it("anchors a draft to the last changed line in its range", () => {
    const { container } = renderView({
      draftComments: [draft({ startLine: 2, endLine: 3 })],
    });

    const widget = widgetAfter(container, "const c = 4;");
    expect(widget.textContent).toContain("draft body 1");
    expect(widget.textContent).toContain("Lines 2–3");
  });

  it("skips a draft whose range covers no rendered change", () => {
    const { container } = renderView({
      draftComments: [draft({ startLine: 90, endLine: 95 })],
    });

    expect(widgetRows(container)).toHaveLength(0);
  });
});

describe("UnifiedDiffView review findings", () => {
  const review = block({
    id: "rv",
    author: { kind: "agent", agentId: "agt_rev" },
    body: reviewBody("request_changes", "s", [
      {
        id: "f1",
        severity: "major",
        title: "Off by one",
        body: "c should be 5.",
        path: FILE_PATH,
        line: 3,
      },
      {
        id: "f2",
        severity: "nit",
        title: "Elsewhere",
        body: "x",
        path: "src/other.ts",
        line: 3,
      },
      { id: "f3", severity: "nit", title: "No place", body: "y" },
    ]),
  }) as Extract<ReturnType<typeof block>, { kind: "review" }>;
  const items: DiffFinding[] = review.data.findings.map((finding) => ({
    key: `rv:${finding.id}`,
    block: review,
    finding,
    record: null,
    reviewerName: "reviewer",
  }));

  it("places a finding under the line it names, and only in its own file", () => {
    const onOpen = vi.fn();
    const onSetState = vi.fn();
    const { container } = renderView({
      findings: {
        items,
        focusedKey: null,
        onFocusComplete: vi.fn(),
        onOpen,
        onSetState,
        disabled: false,
        nameOf: () => "reviewer",
      },
    });
    expect(widgetRows(container)).toHaveLength(1);
    const widget = widgetAfter(container, "const c = 4;");
    const card = widget.querySelector("[data-testid='diff-finding']")!;
    expect(card.getAttribute("data-finding-key")).toBe("rv:f1");
    expect(card.textContent).toContain("Off by one");
    expect(card.textContent).toContain("reviewer");
    expect(card.getAttribute("data-expanded")).toBe("false");

    fireEvent.click(card.querySelector("[data-testid='diff-finding-header']")!);
    expect(card.getAttribute("data-expanded")).toBe("true");
    expect(card.textContent).toContain("c should be 5.");
    fireEvent.click(card.querySelector("[data-testid='chat-review-resolve']")!);
    expect(onSetState).toHaveBeenCalledWith("rv", "f1", "fixed");
    fireEvent.click(card.querySelector("[data-testid='diff-finding-open']")!);
    expect(onOpen).toHaveBeenCalledWith("rv", "f1");
  });

  it("expands and reports the focused finding", () => {
    const onFocusComplete = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    const { container } = renderView({
      findings: {
        items,
        focusedKey: "rv:f1",
        onFocusComplete,
        onOpen: vi.fn(),
        disabled: false,
        nameOf: () => "reviewer",
      },
    });
    const card = container.querySelector("[data-testid='diff-finding']")!;
    expect(card.getAttribute("data-expanded")).toBe("true");
  });
});

describe("UnifiedDiffView inline comment form", () => {
  const selection = {
    filePath: FILE_PATH,
    startLine: 2,
    endLine: 3,
    anchorLine: 2,
  };

  it("only opens the form when a selection, an agent and an open flag are all present", () => {
    for (const props of [
      { lineSelection: null, commentOpen: true },
      { lineSelection: selection, commentOpen: false },
      { lineSelection: selection, commentOpen: true, agentId: null },
    ]) {
      const { container } = renderView(props);
      expect(screen.queryByPlaceholderText("Leave a comment…")).toBeNull();
      expect(widgetRows(container)).toHaveLength(0);
      cleanup();
    }
  });

  it("anchors the form to the last selected change and labels the range", () => {
    const { container } = renderView({
      lineSelection: selection,
      commentOpen: true,
    });

    const widget = widgetAfter(container, "const c = 4;");
    expect(widget.textContent).toContain("Add a comment");
    expect(widget.textContent).toContain("Lines 2–3");
  });

  it("cancelling closes the form and clears the selection", () => {
    const { onCommentOpen, onLineSelection } = renderView({
      lineSelection: selection,
      commentOpen: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCommentOpen).toHaveBeenCalledWith(false);
    expect(onLineSelection).toHaveBeenCalledWith(null);
  });

  it("adds a trimmed draft in review mode and closes the form", () => {
    const { onAddDraft, onCommentOpen, onLineSelection, onStartReview } =
      renderView({
        lineSelection: selection,
        commentOpen: true,
        reviewMode: true,
      });

    fireEvent.change(screen.getByPlaceholderText("Leave a comment…"), {
      target: { value: "  needs a guard  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

    expect(onAddDraft).toHaveBeenCalledWith(FILE_PATH, 2, 3, "needs a guard");
    expect(onStartReview).not.toHaveBeenCalled();
    expect(onCommentOpen).toHaveBeenCalledWith(false);
    expect(onLineSelection).toHaveBeenCalledWith(null);
  });

  it("starts a review before adding the draft outside review mode", () => {
    const { onAddDraft, onStartReview } = renderView({
      lineSelection: selection,
      commentOpen: true,
      reviewMode: false,
    });

    fireEvent.change(screen.getByPlaceholderText("Leave a comment…"), {
      target: { value: "needs a guard" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start a review" }));

    expect(onStartReview).toHaveBeenCalledTimes(1);
    expect(onAddDraft).toHaveBeenCalledWith(FILE_PATH, 2, 3, "needs a guard");
  });

  it("does nothing when the comment is only whitespace", () => {
    const { onAddDraft, onCommentOpen } = renderView({
      lineSelection: selection,
      commentOpen: true,
      reviewMode: true,
    });

    fireEvent.change(screen.getByPlaceholderText("Leave a comment…"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

    expect(onAddDraft).not.toHaveBeenCalled();
    expect(onCommentOpen).not.toHaveBeenCalled();
  });
});

describe("UnifiedDiffView gutter selection", () => {
  it("selects the clicked line", () => {
    const { container, onLineSelection } = renderView();

    clickGutter(container, "const b = 3;");

    expect(onLineSelection).toHaveBeenCalledWith({
      filePath: FILE_PATH,
      startLine: 2,
      endLine: 2,
      anchorLine: 2,
    });
  });

  it("ignores a deleted line, which has no new-side number", () => {
    const { container, onLineSelection } = renderView();

    clickGutter(container, "const b = 2;");

    expect(onLineSelection).not.toHaveBeenCalled();
  });

  it("shift-clicking below the anchor extends the range", () => {
    const { container, onLineSelection } = renderView({
      lineSelection: {
        filePath: FILE_PATH,
        startLine: 2,
        endLine: 2,
        anchorLine: 2,
      },
    });

    clickGutter(container, "console.log(b);", { shiftKey: true });

    expect(onLineSelection).toHaveBeenCalledWith({
      filePath: FILE_PATH,
      startLine: 2,
      endLine: 5,
      anchorLine: 2,
    });
  });

  it("shift-clicking above the anchor keeps the anchor and orders the range", () => {
    const { container, onLineSelection } = renderView({
      lineSelection: {
        filePath: FILE_PATH,
        startLine: 4,
        endLine: 4,
        anchorLine: 4,
      },
    });

    clickGutter(container, "const b = 3;", { shiftKey: true });

    expect(onLineSelection).toHaveBeenCalledWith({
      filePath: FILE_PATH,
      startLine: 2,
      endLine: 4,
      anchorLine: 4,
    });
  });

  it("clicking inside the current selection clears it", () => {
    const { container, onLineSelection } = renderView({
      lineSelection: {
        filePath: FILE_PATH,
        startLine: 2,
        endLine: 4,
        anchorLine: 2,
      },
    });

    clickGutter(container, "const c = 4;");

    expect(onLineSelection).toHaveBeenCalledWith(null);
  });

  it("clicking outside the current selection starts a new one", () => {
    const { container, onLineSelection } = renderView({
      lineSelection: {
        filePath: FILE_PATH,
        startLine: 2,
        endLine: 3,
        anchorLine: 2,
      },
    });

    clickGutter(container, "console.log(b);");

    expect(onLineSelection).toHaveBeenCalledWith({
      filePath: FILE_PATH,
      startLine: 5,
      endLine: 5,
      anchorLine: 5,
    });
  });

  it("marks the selected changes in the gutter", () => {
    const { container } = renderView({
      lineSelection: {
        filePath: FILE_PATH,
        startLine: 2,
        endLine: 3,
        anchorLine: 2,
      },
    });

    const selectedRows = new Set(
      Array.from(container.querySelectorAll(".diff-gutter-selected")).map(
        (el) => el.closest("tr")
      )
    );
    expect(selectedRows).toContain(rowFor(container, "const b = 3;"));
    expect(selectedRows).toContain(rowFor(container, "const c = 4;"));
    expect(selectedRows).not.toContain(rowFor(container, "console.log(a);"));
  });

  it("offers the comment affordance for a selection and opens the form", () => {
    const { container, onCommentOpen } = renderView({
      lineSelection: {
        filePath: FILE_PATH,
        startLine: 2,
        endLine: 3,
        anchorLine: 2,
      },
    });

    const button = commentButton(container);
    expect(button).not.toBeNull();
    fireEvent.click(button!);

    expect(onCommentOpen).toHaveBeenCalledWith(true);
  });

  it("hides the comment affordance with no selection and while the form is open", () => {
    const { container } = renderView();
    expect(commentButton(container)).toBeNull();
    cleanup();

    const open = renderView({
      lineSelection: {
        filePath: FILE_PATH,
        startLine: 2,
        endLine: 3,
        anchorLine: 2,
      },
      commentOpen: true,
    });
    expect(commentButton(open.container)).toBeNull();
  });
});
