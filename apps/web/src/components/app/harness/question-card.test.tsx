// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HarnessQuestion } from "@dispatch/shared";

import { QuestionCard } from "./question-card";

vi.mock("@/components/ui/markdown-mermaid", () => ({
  MermaidBlock: () => null,
}));
vi.mock("@/components/ui/markdown-mermaid-theme", () => ({
  useMermaidTheme: () => "default",
}));

afterEach(cleanup);

const question: HarnessQuestion = {
  id: "q1",
  text: "Fix the preview alone, or bundle it?",
  options: [
    { label: "Preview only" },
    { label: "**Bundle**", value: "bundle" },
  ],
  allowFreeform: true,
  answer: null,
  createdAt: "2026-09-04T10:00:00.500Z",
};

describe("QuestionCard", () => {
  it("gives every option a real tap target on a coarse pointer", () => {
    // The Chat feed's card does this; without it the buttons are 28px tall
    // on a phone and clip a long label.
    render(
      <QuestionCard
        question={question}
        answering={false}
        disabled={false}
        onAnswer={() => {}}
      />
    );
    for (const option of screen.getAllByTestId("harness-question-option")) {
      expect(option.className).toContain("[@media(pointer:coarse)]:min-h-11");
      expect(option.className).toContain("max-sm:min-h-11");
    }
  });

  it("renders option labels as inline markdown", () => {
    render(
      <QuestionCard
        question={question}
        answering={false}
        disabled={false}
        onAnswer={() => {}}
      />
    );
    const bundle = screen.getAllByTestId("harness-question-option")[1];
    expect(bundle.textContent).toBe("Bundle");
    expect(bundle.querySelector("strong")).not.toBeNull();
  });

  it("disables every option once answered and marks the chosen one", () => {
    // The chosen button used to stay enabled with pointer-events-none, so it
    // kept its place in the tab order and Enter re-fired the answer, which
    // came back as a spurious "Answer failed."
    const onAnswer = vi.fn();
    render(
      <QuestionCard
        question={{
          ...question,
          answer: { value: "bundle", label: "**Bundle**" },
        }}
        answering={false}
        disabled={false}
        onAnswer={onAnswer}
      />
    );
    const options = screen.getAllByTestId("harness-question-option");
    expect(options.map((o) => (o as HTMLButtonElement).disabled)).toEqual([
      true,
      true,
    ]);
    expect(options[1].getAttribute("aria-pressed")).toBe("true");
    expect(options[0].getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(options[1]);
    expect(onAnswer).not.toHaveBeenCalled();
    // The answered echo is markdown too, so it reads the same as the button.
    expect(screen.getByTestId("harness-question").textContent).toContain(
      "Bundle"
    );
    expect(
      screen.getByTestId("harness-question").querySelectorAll("strong").length
    ).toBeGreaterThan(0);
  });

  it("offers a typed reply only while one can be sent", () => {
    const { rerender } = render(
      <QuestionCard
        question={question}
        answering={false}
        disabled={false}
        onAnswer={() => {}}
      />
    );
    expect(screen.getByTestId("harness-question").textContent).toContain(
      "Or type a reply below."
    );
    rerender(
      <QuestionCard
        question={question}
        answering={false}
        disabled
        onAnswer={() => {}}
      />
    );
    expect(screen.getByTestId("harness-question").textContent).not.toContain(
      "Or type a reply below."
    );
  });
});
