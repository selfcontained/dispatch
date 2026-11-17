// @vitest-environment jsdom
import { ChatRowStateContext } from "../chat-row-state";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  ResponsePlaceholder,
  ResponsePlaceholderVisual,
  defragCells,
} from "./response-placeholder";
import type { Step } from "./contracts";
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
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
      cells={defragCells("palette-test", ["think"])}
      pieces={[{ key: "thinking:1", category: "think", label: "Thinking" }]}
      reducedCells={defragCells("palette-test", Array(90).fill("checks"))}
    />
  );
  const previewFrame = preview.getByTestId("chat-response-placeholder");
  expect(
    [...previewFrame.classList]
      .filter((value) => value !== "dispatch-defrag-reduced")
      .sort()
  ).toEqual(classes);
  expect(
    [...previewFrame.querySelectorAll("[data-defrag-cell] > span")].map(
      (el) => (el as HTMLElement).style.background
    )
  ).toEqual(backgrounds);
});

it("counts entering fallback thinking once, including return from nested work", () => {
  const active: Step = {
    id: "parent",
    kind: "execute",
    label: "command",
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
    <ResponsePlaceholder seed="thinking-phase" steps={[active]} />
  );
  expect(view.getAllByTestId("chat-response-placeholder-block")).toHaveLength(
    1
  );
  const completed = { ...active, status: "ok" as const, endedAt: 2 };
  view.rerender(
    <ResponsePlaceholder seed="thinking-phase" steps={[completed]} />
  );
  expect(view.getAllByTestId("chat-response-placeholder-block")).toHaveLength(
    2
  );
  expect(
    view
      .getByTitle("Thinking")
      .firstElementChild?.classList.contains("dispatch-defrag-ack")
  ).toBe(true);
  view.rerender(
    <ResponsePlaceholder
      seed="thinking-phase"
      steps={[{ ...completed, updatedAt: 3 }]}
      lastProgressAt={4}
    />
  );
  expect(view.getAllByTestId("chat-response-placeholder-block")).toHaveLength(
    2
  );
  view.rerender(
    <ResponsePlaceholder
      seed="thinking-phase"
      steps={[{ ...completed, children: [child] }]}
    />
  );
  expect(view.getAllByTestId("chat-response-placeholder-block")).toHaveLength(
    3
  );
  view.rerender(
    <ResponsePlaceholder
      seed="thinking-phase"
      steps={[
        { ...completed, children: [{ ...child, status: "ok", endedAt: 5 }] },
      ]}
    />
  );
  expect(view.getAllByTestId("chat-response-placeholder-block")).toHaveLength(
    4
  );
});

it("does not duplicate explicit thinking or cached fallback thinking", () => {
  const cache = new Map<string, unknown>();
  const show = (steps: Step[]) => (
    <ChatRowStateContext.Provider value={cache}>
      <ResponsePlaceholder seed="thinking-cache" steps={steps} />
    </ChatRowStateContext.Provider>
  );
  const thinking: Step = {
    id: "thought",
    kind: "think",
    label: "thinking",
    status: "running",
    startedAt: 0,
  };
  const explicit = render(show([thinking]));
  expect(
    explicit.getAllByTestId("chat-response-placeholder-block")
  ).toHaveLength(1);
  explicit.rerender(show([{ ...thinking, status: "ok", endedAt: 2 }]));
  expect(
    explicit.getAllByTestId("chat-response-placeholder-block")
  ).toHaveLength(1);
  explicit.unmount();
  cache.clear();
  const idle = render(show([]));
  expect(idle.getAllByTestId("chat-response-placeholder-block")).toHaveLength(
    1
  );
  idle.unmount();
  const restored = render(show([]));
  expect(
    restored.getAllByTestId("chat-response-placeholder-block")
  ).toHaveLength(1);
  expect(
    restored.container.querySelectorAll(".dispatch-defrag-ack")
  ).toHaveLength(0);
});

it("matches the activity line when newer progress changes preparing to thinking", () => {
  const pending: Step = {
    id: "pending",
    kind: "execute",
    label: "command",
    status: "pending",
    startedAt: 0,
    updatedAt: 1,
  };
  const view = render(
    <ResponsePlaceholder
      seed="preparing"
      steps={[pending]}
      lastProgressAt={0}
    />
  );
  expect(view.getAllByTestId("chat-response-placeholder-block")).toHaveLength(
    1
  );
  view.rerender(
    <ResponsePlaceholder
      seed="preparing"
      steps={[pending]}
      lastProgressAt={2}
    />
  );
  expect(view.getAllByTestId("chat-response-placeholder-block")).toHaveLength(
    2
  );
  view.rerender(
    <ResponsePlaceholder
      seed="preparing"
      steps={[pending]}
      lastProgressAt={3}
    />
  );
  expect(view.getAllByTestId("chat-response-placeholder-block")).toHaveLength(
    2
  );
});

it("packs real compaction from the front, keeps running, then resumes on the same grid", () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const tool: Step = {
    id: "tool",
    kind: "read",
    label: "read",
    status: "running",
    startedAt: 0,
  };
  const compact: Step = {
    id: "compact",
    kind: "compaction",
    label: "compacting context",
    status: "running",
    startedAt: 2,
  };
  const normal: Step = {
    id: "normal",
    kind: "execute",
    label: "git status",
    status: "running",
    startedAt: 4,
  };
  const cache = new Map<string, unknown>();
  const show = (steps: Step[]) => (
    <ChatRowStateContext.Provider value={cache}>
      <ResponsePlaceholder seed="real-compaction" steps={steps} />
    </ChatRowStateContext.Provider>
  );
  const view = render(show([tool]));
  const frame = view.getByTestId("chat-response-placeholder");
  view.rerender(show([{ ...tool, status: "ok" }, compact]));
  expect(view.getByRole("status").getAttribute("aria-label")).toBe(
    "Compacting context"
  );
  expect(view.getAllByTestId("chat-response-placeholder-block")).toHaveLength(
    1
  );
  act(() => vi.advanceTimersByTime(3300));
  expect(view.getAllByTestId("chat-response-placeholder-block")).toHaveLength(
    4
  );
  const beforeResume = cache.get("defrag-pieces") as { key: string }[];
  view.rerender(
    show([{ ...tool, status: "ok" }, { ...compact, status: "ok" }, normal])
  );
  expect(view.getByTestId("chat-response-placeholder")).toBe(frame);
  expect(view.getAllByTestId("chat-response-placeholder-block")).toHaveLength(
    5
  );
  expect(
    (cache.get("defrag-pieces") as { key: string }[]).slice(
      0,
      beforeResume.length
    )
  ).toEqual(beforeResume);
  act(() => vi.advanceTimersByTime(5000));
  expect(view.getAllByTestId("chat-response-placeholder-block")).toHaveLength(
    5
  );
  expect(vi.getTimerCount()).toBe(0);
});

it("resumes compaction after cached remount, stays green for minutes, and cancels on failure", () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const compact: Step = {
    id: "compact",
    kind: "compaction",
    label: "compacting context",
    status: "running",
    startedAt: 0,
  };
  const cache = new Map<string, unknown>();
  const show = (step: Step) => (
    <ChatRowStateContext.Provider value={cache}>
      <ResponsePlaceholder seed="long-compaction" steps={[step]} />
    </ChatRowStateContext.Provider>
  );
  const first = render(show(compact));
  act(() => vi.advanceTimersByTime(2200));
  first.unmount();
  expect(vi.getTimerCount()).toBe(0);
  const restored = render(show(compact));
  expect(
    restored.getAllByTestId("chat-response-placeholder-block")
  ).toHaveLength(3);
  act(() => vi.advanceTimersByTime(240000));
  const history = cache.get("defrag-pieces") as { key: string }[];
  expect(new Set(history.map((piece) => piece.key)).size).toBe(history.length);
  expect(history.length).toBeGreaterThan(200);
  const expected = defragCells(
    "long-compaction",
    Array(history.length).fill("checks")
  );
  expect(
    expected.every((cell) => (cell.category ?? cell.rest) === "checks")
  ).toBe(true);
  restored.rerender(show({ ...compact, status: "error", endedAt: 240000 }));
  expect(vi.getTimerCount()).toBe(0);
});
