// @vitest-environment jsdom
import { ChatRowStateContext } from "../chat-row-state";
import { afterEach, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  ResponsePlaceholder,
  ResponsePlaceholderVisual,
  defragCells,
} from "./response-placeholder";
import type { Step } from "./contracts";
afterEach(cleanup);
it("acknowledges nested calls without replaying the piece on status changes", () => {
  const parent: Step = {
    id: "parent",
    kind: "execute",
    label: "outer",
    status: "running",
    startedAt: 0,
  };
  const child: Step = {
    id: "child",
    kind: "read",
    label: "nested read",
    status: "running",
    startedAt: 1,
  };
  const view = render(
    <ResponsePlaceholder seed="nested-test" steps={[parent]} />
  );
  expect(view.getAllByTestId("chat-response-placeholder-block")).toHaveLength(
    1
  );
  view.rerender(
    <ResponsePlaceholder
      seed="nested-test"
      steps={[{ ...parent, children: [child] }]}
    />
  );
  expect(view.getAllByTestId("chat-response-placeholder-block")).toHaveLength(
    2
  );
  const block = view.getByTitle("nested read");
  const acknowledgement = block.firstElementChild;
  expect(acknowledgement?.classList.contains("dispatch-defrag-ack")).toBe(true);
  view.rerender(
    <ResponsePlaceholder
      seed="nested-test"
      steps={[
        { ...parent, children: [{ ...child, status: "ok", endedAt: 2 }] },
      ]}
    />
  );
  expect(view.getAllByTestId("chat-response-placeholder-block")).toHaveLength(
    2
  );
  expect(view.getByTitle("nested read").firstElementChild).toBe(
    acknowledgement
  );
});

it("does not replay acknowledgements when cached work remounts", () => {
  const cache = new Map<string, unknown>();
  const parent: Step = {
    id: "parent",
    kind: "execute",
    label: "outer",
    status: "running",
    startedAt: 0,
  };
  const child: Step = {
    id: "child",
    kind: "read",
    label: "read",
    status: "running",
    startedAt: 1,
  };
  const show = (steps: Step[]) => (
    <ChatRowStateContext.Provider value={cache}>
      <ResponsePlaceholder seed="nested-test" steps={steps} />
    </ChatRowStateContext.Provider>
  );
  const first = render(show([parent]));
  first.rerender(show([{ ...parent, children: [child] }]));
  expect(
    first
      .getByTitle("read")
      .firstElementChild?.classList.contains("dispatch-defrag-ack")
  ).toBe(true);
  first.unmount();
  const restored = render(show([{ ...parent, children: [child] }]));
  expect(
    restored.container.querySelectorAll(".dispatch-defrag-ack")
  ).toHaveLength(0);
});

it("does not replay existing arrivals when metadata changes their cell assignment", () => {
  const steps: Step[] = [
    {
      id: "first",
      kind: "other",
      label: "unknown",
      status: "running",
      startedAt: 0,
    },
    {
      id: "read",
      kind: "read",
      label: "read",
      status: "running",
      startedAt: 1,
    },
    {
      id: "git",
      kind: "execute",
      label: "git status",
      status: "running",
      startedAt: 2,
    },
  ];
  const view = render(
    <ResponsePlaceholder seed="nested-test" steps={steps.slice(0, 2)} />
  );
  view.rerender(<ResponsePlaceholder seed="nested-test" steps={steps} />);
  expect(view.container.querySelectorAll(".dispatch-defrag-ack")).toHaveLength(
    1
  );
  view.rerender(
    <ResponsePlaceholder
      seed="nested-test"
      steps={[
        { ...steps[0]!, label: "mcp__dispatch__post" },
        ...steps.slice(1),
      ]}
    />
  );
  expect(view.getAllByTestId("chat-response-placeholder-block")).toHaveLength(
    3
  );
  expect(view.container.querySelectorAll(".dispatch-defrag-ack")).toHaveLength(
    0
  );
});

it("keeps the preview frame and muted palette identical to the production placeholder", () => {
  const production = render(
    <ResponsePlaceholder seed="palette-test" steps={[]} />
  );
  const frame = production.getByTestId("chat-response-placeholder");
  const classes = [...frame.classList].sort();
  const backgrounds = [
    ...frame.querySelectorAll("[data-defrag-cell] > span"),
  ].map((el) => (el as HTMLElement).style.background);
  production.unmount();
  const preview = render(
    <ResponsePlaceholderVisual
      cells={defragCells("palette-test", [])}
      pieces={[]}
      reducedCells={defragCells("palette-test", Array(90).fill("checks"))}
    />
  );
  const previewFrame = preview.getByTestId("chat-response-placeholder");
  expect(
    [...previewFrame.classList]
      .filter((value) => value !== "dispatch-defrag-preview")
      .sort()
  ).toEqual(classes);
  expect(
    [...previewFrame.querySelectorAll("[data-defrag-cell] > span")].map(
      (el) => (el as HTMLElement).style.background
    )
  ).toEqual(backgrounds);
});
