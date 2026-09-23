// @vitest-environment jsdom
import type { Block } from "@dispatch/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  block,
  formBody,
  findingBlock,
  findingRecord,
  linkBody,
  questionBody,
  reviewBlock,
  tasksBody,
} from "@/test-utils/blocks";

import {
  findingsSummary,
  FormBlockBody,
  LinkBlockBody,
  FindingDetail,
  ReviewBlockBody,
  QuestionOptions,
  summarySentence,
  TasksBlockBody,
} from "./block-bodies";

vi.mock("@/components/ui/markdown", () => ({
  Markdown: ({ children }: { children: string }) => (
    <div data-testid="markdown-mock">{children}</div>
  ),
}));

// The textarea sizes itself with a ResizeObserver jsdom does not have.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  ResizeObserverStub;

afterEach(cleanup);

describe("QuestionOptions", () => {
  const question = (canceled = false) =>
    block({
      id: "q1",
      body: questionBody([{ label: "Yes" }, { label: "No" }]),
      ...(canceled
        ? {
            body: {
              ...questionBody([{ label: "Yes" }, { label: "No" }]),
              state: {
                cancellation: {
                  by: { kind: "user" },
                  at: "2026-09-22T12:00:00.000Z",
                  reason: "No longer needed",
                },
              },
            } as never,
          }
        : {}),
    }) as Extract<Block, { kind: "question" }>;

  it("offers a modest cancel action while the user-addressed ask is open", () => {
    const onCancel = vi.fn();
    render(
      <QuestionOptions
        block={question()}
        answering={false}
        answersDisabled={false}
        onAnswer={vi.fn()}
        onCancel={onCancel}
      />
    );
    fireEvent.click(screen.getByTestId("chat-ask-cancel"));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("keeps a canceled question visible with every choice disabled", () => {
    render(
      <QuestionOptions
        block={question(true)}
        answering={false}
        answersDisabled={false}
        onAnswer={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByTestId("chat-ask-canceled").textContent).toContain(
      "Canceled · No longer needed"
    );
    expect(screen.queryByTestId("chat-ask-cancel")).toBeNull();
    expect(
      screen
        .getAllByTestId("chat-question-option")
        .every((option) => (option as HTMLButtonElement).disabled)
    ).toBe(true);
  });
});

describe("FormBlockBody", () => {
  const form = () =>
    block({
      id: "f1",
      body: formBody(
        [
          { id: "name", label: "Name", type: "text", required: true },
          { id: "notes", label: "Notes", type: "textarea" },
          { id: "ok", label: "Ready", type: "checkbox" },
        ],
        { title: "Release details", submitLabel: "Send it" }
      ),
    }) as Extract<Block, { kind: "form" }>;

  it("renders the fields, keeps submit off until required ones are filled, then submits the values", () => {
    const onSubmit = vi.fn();
    render(
      <FormBlockBody
        block={form()}
        submitting={false}
        disabled={false}
        onSubmit={onSubmit}
      />
    );
    expect(screen.getByTestId("chat-needs-reply").textContent).toContain(
      "Release details"
    );
    expect(screen.getAllByTestId("chat-form-field")).toHaveLength(3);
    const submit = screen.getByTestId("chat-form-submit") as HTMLButtonElement;
    expect(submit.textContent).toBe("Send it");
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "Ada" },
    });
    fireEvent.change(screen.getByLabelText("Notes"), {
      target: { value: "ship it" },
    });
    fireEvent.click(screen.getByLabelText("Ready"));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith({
      name: "Ada",
      notes: "ship it",
      ok: true,
    });
  });

  it("shows a submission read-only with no submit button", () => {
    const submitted = {
      ...form(),
      ...formBody([{ id: "name", label: "Name", type: "text" }], {
        submission: { name: "Ada" },
      }),
    } as Extract<Block, { kind: "form" }>;
    render(
      <FormBlockBody
        block={submitted}
        submitting={false}
        disabled={false}
        onSubmit={vi.fn()}
      />
    );
    expect(screen.queryByTestId("chat-form-submit")).toBeNull();
    expect(screen.queryByTestId("chat-form-field")).toBeNull();
    expect(screen.getByTestId("chat-form-value").textContent).toContain("Ada");
    expect(screen.getByTestId("chat-form").textContent).toContain("Submitted");
  });

  it("locks the fields while nothing can be sent", () => {
    render(
      <FormBlockBody
        block={form()}
        submitting={false}
        disabled
        onSubmit={vi.fn()}
      />
    );
    expect((screen.getByLabelText(/Name/) as HTMLInputElement).disabled).toBe(
      true
    );
    expect(
      (screen.getByTestId("chat-form-submit") as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("keeps a canceled form visible and read-only", () => {
    const onSubmit = vi.fn();
    const canceled = {
      ...form(),
      state: {
        cancellation: {
          by: { kind: "user" },
          at: "2026-09-22T12:00:00.000Z",
        },
      },
    } as unknown as Extract<Block, { kind: "form" }>;
    const { rerender } = render(
      <FormBlockBody
        block={form()}
        submitting={false}
        disabled={false}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "unsent value" },
    });
    rerender(
      <FormBlockBody
        block={canceled}
        submitting={false}
        disabled={false}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByTestId("chat-ask-canceled").textContent).toContain(
      "Canceled · no response is needed"
    );
    expect(screen.getAllByTestId("chat-form-field")).toHaveLength(3);
    expect((screen.getByLabelText(/Name/) as HTMLInputElement).disabled).toBe(
      true
    );
    expect((screen.getByLabelText(/Name/) as HTMLInputElement).value).toBe(
      "unsent value"
    );
    expect(screen.queryByTestId("chat-form-submit")).toBeNull();
    expect(screen.queryByTestId("chat-ask-cancel")).toBeNull();
    fireEvent.submit(screen.getByTestId("chat-form"));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("ReviewBlockBody", () => {
  const nullDeref = () =>
    findingBlock("f1", {
      severity: "blocker",
      title: "Null deref",
      body: "Guard the lookup.",
      path: "src/a.ts",
      line: 12,
    });
  const typo = (overrides: Parameters<typeof findingBlock>[2] = {}) =>
    findingBlock(
      "f2",
      { severity: "nit", title: "Typo", body: "" },
      {
        record: findingRecord("dismissed", { note: "Not worth a change." }),
        ...overrides,
      }
    );
  const review = (findings: Block[] = [nullDeref(), typo()]) =>
    reviewBlock({
      id: "rv1",
      summary: "Two things need work. The rest is fine.",
      findings,
    });

  it("collapses to one header line and opens into finding rows", () => {
    render(<ReviewBlockBody block={review()} />);
    const header = screen.getByTestId("chat-review-header");
    expect(screen.getByTestId("chat-review-status").textContent).toBe(
      "Changes requested"
    );
    expect(screen.getByTestId("chat-review-counts").textContent).toBe(
      "2 findings · 1 open"
    );
    // Folded: the details are there but closed (they animate open).
    expect(
      screen.getByTestId("chat-review-details").getAttribute("data-open")
    ).toBe("false");

    fireEvent.click(header);
    expect(
      screen.getByTestId("chat-review-details").getAttribute("data-open")
    ).toBe("true");
    expect(screen.getByTestId("chat-review-details").textContent).toContain(
      "Two things need work. The rest is fine."
    );
    const rows = screen.getAllByTestId("chat-review-finding");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.getAttribute("data-finding-id"))).toEqual([
      "f1",
      "f2",
    ]);
    expect(rows[0]!.getAttribute("data-status")).toBe("open");
    expect(rows[0]!.textContent).toContain("Open");
    expect(rows[0]!.textContent).toContain("blocker");
    expect(rows[0]!.textContent).toContain("src/a.ts:12");
    expect(rows[1]!.getAttribute("data-status")).toBe("resolved");
    expect(rows[1]!.getAttribute("data-outcome")).toBe("dismissed");
    expect(rows[1]!.textContent).toContain("Dismissed");
    // Compact rows: the body and the controls wait for the finding panel.
    expect(rows[0]!.textContent).not.toContain("Guard the lookup.");
    expect(screen.queryByTestId("chat-review-resolve")).toBeNull();
  });

  it("derives its status from the findings it shows: any open requests changes, all resolved approves", () => {
    const status = () => screen.getByTestId("chat-review-status");
    // Every finding open.
    render(
      <ReviewBlockBody
        block={review([nullDeref(), typo({ record: findingRecord("open") })])}
      />
    );
    expect(status().textContent).toBe("Changes requested");
    expect(status().getAttribute("data-status")).toBe("open");
    cleanup();

    // One of two resolved: still changes requested.
    render(<ReviewBlockBody block={review()} />);
    expect(status().textContent).toBe("Changes requested");
    expect(status().getAttribute("data-status")).toBe("partially_resolved");
    cleanup();

    // Every finding resolved, fixed or dismissed: approved.
    render(
      <ReviewBlockBody
        block={review([
          findingBlock(
            "f1",
            { severity: "blocker", title: "Null deref", body: "" },
            { record: findingRecord("fixed") }
          ),
          typo(),
        ])}
        defaultExpanded
      />
    );
    expect(status().textContent).toBe("Approved");
    expect(status().getAttribute("data-status")).toBe("resolved");
    expect(screen.getByTestId("chat-review-details").textContent).toContain(
      "Every finding is resolved."
    );
    cleanup();

    // A review with no findings has nothing to fix.
    render(<ReviewBlockBody block={review([])} />);
    expect(status().textContent).toBe("Approved");
    expect(screen.getByTestId("chat-review-counts").textContent).toBe(
      "No findings"
    );
  });

  it("marks a finding fixed, dismisses it with a reason, and reopens it with a note", () => {
    const onSetState = vi.fn();
    render(
      <FindingDetail
        block={nullDeref()}
        disabled={false}
        onSetState={onSetState}
      />
    );
    const detail = screen.getByTestId("chat-finding-detail");
    expect(detail.textContent).toContain("Null deref");
    expect(detail.textContent).toContain("Guard the lookup.");
    expect(detail.textContent).toContain("src/a.ts:12");
    // Only the reviewer's initial stamp: no record line.
    expect(screen.queryByTestId("chat-review-finding-record")).toBeNull();
    fireEvent.click(screen.getByTestId("chat-review-resolve"));
    expect(onSetState).toHaveBeenCalledWith({ status: "fixed" });

    // Dismiss asks why, and will not go without an answer.
    fireEvent.click(screen.getByTestId("chat-review-dismiss"));
    const confirm = screen.getByTestId("chat-review-dismiss-confirm");
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("chat-review-dismiss-note"), {
      target: { value: "Out of scope here." },
    });
    fireEvent.click(confirm);
    expect(onSetState).toHaveBeenLastCalledWith({
      status: "dismissed",
      note: "Out of scope here.",
    });
    cleanup();

    render(
      <FindingDetail
        block={typo()}
        disabled={false}
        onSetState={onSetState}
        authorName={() => "Brad"}
      />
    );
    // The dismissed finding shows who and why.
    const record = screen.getByTestId("chat-review-finding-record");
    expect(record.textContent).toContain("Dismissed by Brad");
    expect(screen.getByTestId("chat-review-finding-note").textContent).toBe(
      "Not worth a change."
    );
    fireEvent.click(screen.getByTestId("chat-review-reopen"));
    fireEvent.click(screen.getByTestId("chat-review-reopen-confirm"));
    expect(onSetState).toHaveBeenLastCalledWith({ status: "open" });
    fireEvent.click(screen.getByTestId("chat-review-reopen"));
    fireEvent.change(screen.getByTestId("chat-review-reopen-note"), {
      target: { value: "Still wrong on mobile." },
    });
    fireEvent.click(screen.getByTestId("chat-review-reopen-confirm"));
    expect(onSetState).toHaveBeenLastCalledWith({
      status: "open",
      note: "Still wrong on mobile.",
    });
  });

  it("offers no controls on a finding nobody can change, and locks them while disabled", () => {
    render(<FindingDetail block={nullDeref()} disabled={false} />);
    expect(screen.queryByTestId("chat-review-finding-actions")).toBeNull();
    cleanup();
    render(<FindingDetail block={nullDeref()} disabled onSetState={vi.fn()} />);
    expect(
      (screen.getByTestId("chat-review-resolve") as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("in the stream is a summary line that opens the review", () => {
    const onOpen = vi.fn();
    render(
      <ReviewBlockBody
        block={review()}
        compact
        onOpen={onOpen}
        defaultExpanded
      />
    );
    const card = screen.getByTestId("chat-review-block");
    expect(card.getAttribute("data-compact")).toBe("true");
    expect(screen.getByTestId("chat-review-summary-line").textContent).toBe(
      "Two things need work."
    );
    expect(screen.queryByTestId("chat-review-details")).toBeNull();
    expect(screen.queryByTestId("chat-review-finding")).toBeNull();
    fireEvent.click(screen.getByTestId("chat-review-header"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("marks findings with unseen agent comments and counts them on the header", () => {
    render(
      <ReviewBlockBody
        block={review([
          { ...nullDeref(), replyCount: 2, unreadReplies: 2 },
          { ...typo(), replyCount: 1, unreadReplies: 0 },
        ])}
        defaultExpanded
      />
    );
    expect(screen.getByTestId("chat-review-unread").textContent).toBe("2");
    const rows = screen.getAllByTestId("chat-review-finding");
    expect(
      rows[0]!.querySelector("[data-testid='chat-review-finding-unread']")
    ).not.toBeNull();
    expect(
      rows[1]!.querySelector("[data-testid='chat-review-finding-unread']")
    ).toBeNull();
  });

  it("opens a finding from its row, counts its comments, and highlights the one named", () => {
    const onOpenFinding = vi.fn();
    render(
      <ReviewBlockBody
        block={review([{ ...nullDeref(), replyCount: 2 }, typo()])}
        onOpenFinding={onOpenFinding}
        defaultExpanded
        highlightFindingId="f1"
      />
    );
    fireEvent.click(screen.getAllByTestId("chat-review-finding-link")[0]!);
    expect(onOpenFinding).toHaveBeenCalledWith("f1");
    const rows = screen.getAllByTestId("chat-review-finding");
    expect(rows[0]!.getAttribute("data-highlighted")).toBe("true");
    expect(rows[0]!.textContent).toContain("2 comments");
    expect(rows[1]!.getAttribute("data-highlighted")).toBeNull();
    expect(rows[1]!.textContent).not.toContain("comment");
  });

  it("summarises findings and summaries", () => {
    expect(findingsSummary(review())).toBe("2 findings · 1 open");
    expect(findingsSummary(review([]))).toBe("No findings");
    // Only finding blocks count: anything else a review showed is skipped.
    expect(
      findingsSummary({
        ...review(),
        blocks: [nullDeref(), block({ id: "t1" })],
      })
    ).toBe("1 finding · 1 open");
    expect(summarySentence("# Heading\n\nFirst one. Second one.")).toBe(
      "First one."
    );
    expect(summarySentence("No punctuation here")).toBe("No punctuation here");
  });
});

describe("TasksBlockBody", () => {
  const tasks = (state: Record<string, "todo" | "now" | "done">) =>
    block({
      id: "t1",
      body: tasksBody(
        [
          { id: "a", text: "Write the migration" },
          { id: "b", text: "Wire the route" },
        ],
        { items: state }
      ),
    }) as Extract<Block, { kind: "tasks" }>;

  it("renders the checklist read-only with the current item marked", () => {
    render(<TasksBlockBody block={tasks({ a: "done", b: "now" })} />);
    expect(screen.getByTestId("chat-tasks-header").textContent).toContain(
      "1/2 done"
    );
    const rows = screen.getAllByTestId("chat-task");
    expect(rows[0]!.getAttribute("data-status")).toBe("done");
    expect(rows[1]!.getAttribute("data-status")).toBe("now");
    expect(
      rows[1]!.querySelector("[data-testid='chat-task-now']")
    ).toBeTruthy();
    // The agent moves items with `update`; there is nothing here to click.
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("folds to its count line once every item is done, and opens on click", () => {
    render(<TasksBlockBody block={tasks({ a: "done", b: "done" })} />);
    expect(screen.queryByTestId("chat-task")).toBeNull();
    fireEvent.click(screen.getByTestId("chat-tasks-header"));
    expect(screen.getAllByTestId("chat-task")).toHaveLength(2);
  });
});

describe("LinkBlockBody", () => {
  it("renders the link as a card with its host", () => {
    render(
      <LinkBlockBody
        block={
          block({
            id: "l1",
            body: linkBody("https://github.com/o/r/pull/12", "Fix it"),
          }) as Extract<Block, { kind: "link" }>
        }
      />
    );
    const card = screen.getByTestId("chat-link-block-card");
    expect(card.querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/o/r/pull/12"
    );
    expect(card.textContent).toContain("Fix it");
    expect(card.textContent).toContain("github.com");
  });
});
