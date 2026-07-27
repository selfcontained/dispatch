// @vitest-environment jsdom
import type { ReactNode } from "react";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReviewThreadMessage } from "@/hooks/use-agent-reviews";

import {
  FeedbackReplyForm,
  FeedbackResolutionFooter,
  FeedbackThreadMessage,
} from "./feedback-card-parts";

vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  const React = await import("react");
  const MOTION_ONLY_PROPS = new Set([
    "layout",
    "layoutId",
    "initial",
    "animate",
    "exit",
    "transition",
    "variants",
  ]);
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) =>
        React.forwardRef<HTMLElement, Record<string, unknown>>((props, ref) => {
          const domProps = Object.fromEntries(
            Object.entries(props).filter(([key]) => !MOTION_ONLY_PROPS.has(key))
          );
          return React.createElement(tag, { ...domProps, ref });
        }),
    }
  );
  return {
    ...actual,
    motion,
    AnimatePresence: ({ children }: { children?: ReactNode }) => children,
  };
});

afterEach(() => {
  cleanup();
});

type ReplyFormProps = Parameters<typeof FeedbackReplyForm>[0];

function renderReplyForm(overrides: Partial<ReplyFormProps> = {}) {
  const props: ReplyFormProps = {
    replying: true,
    reply: "",
    isPending: false,
    variant: "sidebar",
    onReplyChange: vi.fn(),
    onStartReply: vi.fn(),
    onCancelReply: vi.fn(),
    onSubmit: vi.fn((event: React.FormEvent) => event.preventDefault()),
    ...overrides,
  };
  const view = render(<FeedbackReplyForm {...props} />);
  return { props, view };
}

describe("FeedbackReplyForm", () => {
  it("shows only the Reply trigger when not replying and starts a reply on click", () => {
    const { props } = renderReplyForm({ replying: false });

    expect(screen.queryByLabelText("Reply to feedback")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(props.onStartReply).toHaveBeenCalledTimes(1);
  });

  it("forwards typed input through onReplyChange", () => {
    const { props } = renderReplyForm({ reply: "dra" });

    fireEvent.change(screen.getByLabelText("Reply to feedback"), {
      target: { value: "draft" },
    });
    expect(props.onReplyChange).toHaveBeenCalledWith("draft");
  });

  it("disables Send until the reply has non-whitespace content", () => {
    const { view } = renderReplyForm({ reply: "   " });
    const send = () =>
      screen.getByRole<HTMLButtonElement>("button", { name: "Send reply" });

    expect(send().disabled).toBe(true);
    view.rerender(
      <FeedbackReplyForm
        replying
        reply="done"
        isPending={false}
        variant="sidebar"
        onReplyChange={vi.fn()}
        onStartReply={vi.fn()}
        onCancelReply={vi.fn()}
        onSubmit={vi.fn((event: React.FormEvent) => event.preventDefault())}
      />
    );
    expect(send().disabled).toBe(false);
  });

  it("submits with Cmd+Enter and Ctrl+Enter from the textarea", () => {
    const { props } = renderReplyForm({ reply: "ship it" });
    const textarea = screen.getByLabelText("Reply to feedback");

    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    expect(props.onSubmit).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    expect(props.onSubmit).toHaveBeenCalledTimes(2);
  });

  it("does not submit on a plain Enter keydown", () => {
    const { props } = renderReplyForm({ reply: "ship it" });

    fireEvent.keyDown(screen.getByLabelText("Reply to feedback"), {
      key: "Enter",
    });
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("cancels the reply on Escape and via the Cancel button", () => {
    const { props } = renderReplyForm({ reply: "ship it" });

    fireEvent.keyDown(screen.getByLabelText("Reply to feedback"), {
      key: "Escape",
    });
    expect(props.onCancelReply).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onCancelReply).toHaveBeenCalledTimes(2);
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("disables the textarea, Cancel, and Send while pending", () => {
    renderReplyForm({ reply: "ship it", isPending: true });

    expect(
      screen.getByLabelText<HTMLTextAreaElement>("Reply to feedback").disabled
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Cancel" }).disabled
    ).toBe(true);
    const send = screen.getByRole<HTMLButtonElement>("button", {
      name: "Send reply",
    });
    expect(send.disabled).toBe(true);
    expect(send.querySelector(".animate-spin")).not.toBeNull();
  });

  it("right-aligns and width-caps the action row only for the inline variant", () => {
    const { view } = renderReplyForm({ reply: "x", variant: "inline" });
    const actionRow = () =>
      screen.getByRole("button", { name: "Cancel" }).parentElement!;

    expect(actionRow().className).toContain("ml-auto");
    expect(actionRow().className).toContain("max-w-sm");

    view.rerender(
      <FeedbackReplyForm
        replying
        reply="x"
        isPending={false}
        variant="sidebar"
        onReplyChange={vi.fn()}
        onStartReply={vi.fn()}
        onCancelReply={vi.fn()}
        onSubmit={vi.fn((event: React.FormEvent) => event.preventDefault())}
      />
    );
    expect(actionRow().className).not.toContain("ml-auto");
    expect(actionRow().className).not.toContain("max-w-sm");
  });
});

type FooterProps = Parameters<typeof FeedbackResolutionFooter>[0];

function renderFooter(overrides: Partial<FooterProps> = {}) {
  const props: FooterProps = {
    state: "open",
    resolution: null,
    resolutionNote: null,
    isPending: false,
    pendingResolution: undefined,
    variant: "sidebar",
    onUpdateResolution: vi.fn(),
    ...overrides,
  };
  const view = render(<FeedbackResolutionFooter {...props} />);
  return { props, view };
}

describe("FeedbackResolutionFooter", () => {
  it("offers Dismiss and Mark fixed for open feedback", () => {
    const { props } = renderFooter();

    expect(
      screen.queryByRole("button", { name: "Reopen feedback" })
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(props.onUpdateResolution).toHaveBeenCalledWith("dismissed");

    fireEvent.click(screen.getByRole("button", { name: "Mark fixed" }));
    expect(props.onUpdateResolution).toHaveBeenCalledWith("fixed");
  });

  it("offers Reopen for resolved feedback and clears the resolution", () => {
    const { props } = renderFooter({ state: "fixed", resolution: "fixed" });

    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark fixed" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reopen feedback" }));
    expect(props.onUpdateResolution).toHaveBeenCalledWith(null);
  });

  it("shows the spinner on Mark fixed while a fix is pending", () => {
    renderFooter({ isPending: true, pendingResolution: "fixed" });

    const dismiss = screen.getByRole<HTMLButtonElement>("button", {
      name: "Dismiss",
    });
    const markFixed = screen.getByRole<HTMLButtonElement>("button", {
      name: "Mark fixed",
    });
    expect(markFixed.querySelector(".animate-spin")).not.toBeNull();
    expect(dismiss.querySelector(".animate-spin")).toBeNull();
    expect(dismiss.disabled).toBe(true);
    expect(markFixed.disabled).toBe(true);
  });

  it("shows the spinner on Dismiss while a dismissal is pending", () => {
    renderFooter({ isPending: true, pendingResolution: "dismissed" });

    expect(
      screen
        .getByRole("button", { name: "Dismiss" })
        .querySelector(".animate-spin")
    ).not.toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Mark fixed" })
        .querySelector(".animate-spin")
    ).toBeNull();
  });

  it("shows the spinner on Reopen while clearing a resolution", () => {
    renderFooter({
      state: "dismissed",
      resolution: "dismissed",
      isPending: true,
      pendingResolution: null,
    });

    const reopen = screen.getByRole<HTMLButtonElement>("button", {
      name: "Reopen feedback",
    });
    expect(reopen.querySelector(".animate-spin")).not.toBeNull();
    expect(reopen.disabled).toBe(true);
  });

  it("renders a fixed resolution banner with the note", () => {
    renderFooter({
      state: "fixed",
      resolution: "fixed",
      resolutionNote: "Patched in abc123",
    });

    const banner = screen
      .getByText("Resolution: fixed")
      .closest("div")!.parentElement!;
    expect(banner.className).toContain("border-status-working/25");
    expect(screen.getByText("Patched in abc123")).toBeTruthy();
  });

  it("renders a dismissed resolution banner with muted styling", () => {
    renderFooter({ state: "dismissed", resolution: "dismissed" });

    const banner = screen
      .getByText("Resolution: dismissed")
      .closest("div")!.parentElement!;
    expect(banner.className).toContain("border-muted-foreground/25");
  });

  it("renders no banner while the feedback is unresolved", () => {
    renderFooter();
    expect(screen.queryByText(/Resolution:/)).toBeNull();
  });
});

function threadMessage(
  overrides: Partial<ReviewThreadMessage> = {}
): ReviewThreadMessage {
  return {
    id: 1,
    feedbackItemId: 10,
    authorType: "agent",
    authorAgentId: "agt_1",
    type: "comment",
    content: { body: "On it" },
    createdAt: "2026-07-27T10:00:00.000Z",
    ...overrides,
  };
}

describe("FeedbackThreadMessage", () => {
  it("renders a plain comment with the author label", () => {
    render(<FeedbackThreadMessage message={threadMessage()} grouped={false} />);

    expect(screen.getByText("Agent")).toBeTruthy();
    expect(screen.getByText("On it")).toBeTruthy();
  });

  it("labels a body-less resolution as a state change instead of an empty bubble", () => {
    render(
      <FeedbackThreadMessage
        message={threadMessage({
          type: "resolution",
          content: { body: "", resolution: "fixed" },
        })}
        grouped={false}
      />
    );

    expect(screen.getByText("State change")).toBeTruthy();
    expect(screen.getByText("Marked fixed")).toBeTruthy();
  });

  it("prefixes the state-change label when a resolution has a note body", () => {
    render(
      <FeedbackThreadMessage
        message={threadMessage({
          type: "resolution",
          content: { body: "Verified in CI", resolution: "dismissed" },
        })}
        grouped={false}
      />
    );

    expect(screen.getByText("Marked dismissed")).toBeTruthy();
    expect(screen.getByText("Verified in CI")).toBeTruthy();
  });

  it("labels a reopen message", () => {
    render(
      <FeedbackThreadMessage
        message={threadMessage({ type: "reopen", content: { body: "" } })}
        grouped={false}
      />
    );

    expect(screen.getByText("Reopened feedback")).toBeTruthy();
  });

  it("hides the author header when grouped with the previous message", () => {
    render(<FeedbackThreadMessage message={threadMessage()} grouped />);

    expect(screen.queryByText("Agent")).toBeNull();
    expect(screen.getByText("On it")).toBeTruthy();
  });
});
