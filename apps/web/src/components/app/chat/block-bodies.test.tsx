// @vitest-environment jsdom
import type { Block } from "@dispatch/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  block,
  formBody,
  linkBody,
  reviewBody,
  tasksBody,
} from "@/test-utils/blocks";

import {
  findingsSummary,
  FormBlockBody,
  LinkBlockBody,
  ReviewBlockBody,
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
});

describe("ReviewBlockBody", () => {
  const review = () =>
    block({
      id: "rv1",
      body: reviewBody(
        "request_changes",
        "Two things need work. The rest is fine.",
        [
          {
            id: "f1",
            severity: "blocker",
            title: "Null deref",
            body: "Guard the lookup.",
            path: "src/a.ts",
            line: 12,
          },
          { id: "f2", severity: "nit", title: "Typo", body: "" },
        ],
        {
          findings: {
            f2: {
              status: "resolved",
              by: { kind: "user" },
              at: "2026-09-02T10:00:30.000Z",
            },
          },
        }
      ),
    }) as Extract<Block, { kind: "review" }>;

  it("collapses to one header line and opens into finding rows", () => {
    render(
      <ReviewBlockBody block={review()} disabled={false} onSetState={vi.fn()} />
    );
    const header = screen.getByTestId("chat-review-header");
    expect(screen.getByTestId("chat-review-verdict").textContent).toBe(
      "Changes requested"
    );
    expect(header.textContent).toContain("Two things need work.");
    expect(header.textContent).not.toContain("The rest is fine.");
    expect(screen.getByTestId("chat-review-counts").textContent).toBe(
      "2 findings · 1 open"
    );
    expect(screen.queryByTestId("chat-review-findings")).toBeNull();

    fireEvent.click(header);
    const rows = screen.getAllByTestId("chat-review-finding");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.getAttribute("data-status")).toBe("open");
    expect(rows[0]!.textContent).toContain("blocker");
    expect(rows[0]!.textContent).toContain("src/a.ts:12");
    expect(rows[1]!.getAttribute("data-status")).toBe("resolved");
    // Compact rows: the body waits for the panel.
    expect(rows[0]!.textContent).not.toContain("Guard the lookup.");
  });

  it("resolves and reopens a finding through a bare-status patch", () => {
    const onSetState = vi.fn();
    render(
      <ReviewBlockBody
        block={review()}
        disabled={false}
        onSetState={onSetState}
        defaultExpanded
      />
    );
    fireEvent.click(screen.getByTestId("chat-review-resolve"));
    expect(onSetState).toHaveBeenCalledWith({
      findings: { f1: "resolved" },
    });
    fireEvent.click(screen.getByTestId("chat-review-reopen"));
    expect(onSetState).toHaveBeenCalledWith({ findings: { f2: "open" } });
  });

  it("deep-links a finding into the thread, and highlights it with its body in the panel", () => {
    const onOpenFinding = vi.fn();
    render(
      <ReviewBlockBody
        block={review()}
        disabled={false}
        onOpenFinding={onOpenFinding}
        defaultExpanded
      />
    );
    fireEvent.click(screen.getAllByTestId("chat-review-finding-link")[0]!);
    expect(onOpenFinding).toHaveBeenCalledWith("f1");
    cleanup();

    render(
      <ReviewBlockBody
        block={review()}
        disabled={false}
        defaultExpanded
        showBodies
        highlightFindingId="f1"
      />
    );
    const rows = screen.getAllByTestId("chat-review-finding");
    expect(rows[0]!.getAttribute("data-highlighted")).toBe("true");
    expect(rows[1]!.getAttribute("data-highlighted")).toBeNull();
    expect(rows[0]!.textContent).toContain("Guard the lookup.");
    expect(screen.queryByTestId("chat-review-resolve")).toBeNull();
  });

  it("summarises findings and summaries", () => {
    expect(findingsSummary(review())).toBe("2 findings · 1 open");
    expect(
      findingsSummary({
        ...review(),
        data: { ...review().data, findings: [] },
      })
    ).toBe("No findings");
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
