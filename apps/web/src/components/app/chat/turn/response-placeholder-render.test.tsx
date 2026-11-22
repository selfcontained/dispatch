// @vitest-environment jsdom
import { DefragPreviewGrid } from "../../compaction-comparison";
import providerFixtures from "../../../../../../../test-fixtures/provider-compactions.json";
import { turnStep } from "./trace";
import type { ChatTurnStep } from "@dispatch/shared";
import { ChatRowStateContext } from "../chat-row-state";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import {
  ACTIVITY_LABELS,
  ResponsePlaceholder,
  ResponsePlaceholderVisual,
  defragCells,
} from "./response-placeholder";
import { ACTIVITY_COLORS } from "./activity-category";
import type { Step } from "./contracts";
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
  const block = view.container.querySelector('[data-category="read"]')!;
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
  expect(
    view.container.querySelector('[data-category="read"]')!.firstElementChild
  ).toBe(acknowledgement);
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
    first.container
      .querySelector('[data-category="read"]')!
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
    view.container
      .querySelector('[data-category="think"]')!
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

it.each(providerFixtures.samples)(
  "detects $runtime/$model recorded compaction seq$seq, not a tool label",
  (sample) => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const live = turnStep(sample.liveStep as ChatTurnStep);
    const view = render(
      <ResponsePlaceholder seed={sample.key} steps={[live]} />
    );
    expect(view.getByRole("status").getAttribute("aria-label")).toBe(
      "Compacting context"
    );
    act(() => vi.advanceTimersByTime(2200));
    expect(view.getAllByTestId("chat-response-placeholder-block")).toHaveLength(
      3
    );
    view.rerender(
      <ResponsePlaceholder
        seed={sample.key}
        steps={[turnStep(sample.terminalStep as ChatTurnStep)]}
      />
    );
    expect(view.getByRole("status").getAttribute("aria-label")).toBe(
      "Preparing response"
    );
    expect(vi.getTimerCount()).toBe(0);
  }
);

it("handles recorded Codex cancellation/restart and its multi-minute replacement", () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const [cancelled, restarted] = providerFixtures.samples.filter(
    (sample) => sample.runtime === "codex"
  );
  const view = render(
    <ResponsePlaceholder
      seed="restart"
      steps={[turnStep(cancelled.liveStep as ChatTurnStep)]}
    />
  );
  act(() => vi.advanceTimersByTime(1100));
  view.rerender(
    <ResponsePlaceholder
      seed="restart"
      steps={[turnStep(cancelled.terminalStep as ChatTurnStep)]}
    />
  );
  expect(vi.getTimerCount()).toBe(0);
  view.rerender(
    <ResponsePlaceholder
      seed="restart"
      steps={[
        turnStep(cancelled.terminalStep as ChatTurnStep),
        turnStep(restarted.liveStep as ChatTurnStep),
      ]}
    />
  );
  expect(view.getByRole("status").getAttribute("aria-label")).toBe(
    "Compacting context"
  );
  act(() =>
    vi.advanceTimersByTime(
      Date.parse(restarted.updatedAt) - Date.parse(restarted.createdAt)
    )
  );
  expect(
    view.container.querySelectorAll("[data-defrag-cell]").length
  ).toBeGreaterThan(60);
  view.rerender(
    <ResponsePlaceholder
      seed="restart"
      steps={[
        turnStep(cancelled.terminalStep as ChatTurnStep),
        turnStep(restarted.terminalStep as ChatTurnStep),
      ]}
    />
  );
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the normal grid when a runtime has no explicit compaction entry", () => {
  vi.useFakeTimers();
  const tool: Step = {
    id: "legacy",
    kind: "think",
    label: "compacting context",
    status: "running",
    startedAt: 0,
  };
  const view = render(<ResponsePlaceholder seed="no-signal" steps={[tool]} />);
  expect(view.getByRole("status").getAttribute("aria-label")).toBe(
    "Preparing response"
  );
  act(() => vi.advanceTimersByTime(180000));
  expect(view.getAllByTestId("chat-response-placeholder-block")).toHaveLength(
    1
  );
  expect(vi.getTimerCount()).toBe(0);
});

it("removes the comparison's reduced-motion packed override when normal work resumes", () => {
  const view = render(<DefragPreviewGrid categories={["checks"]} compacting />);
  expect(
    view
      .getByTestId("chat-response-placeholder")
      .classList.contains("dispatch-defrag-reduced")
  ).toBe(true);
  view.rerender(
    <DefragPreviewGrid categories={["checks", "read"]} compacting={false} />
  );
  expect(
    view
      .getByTestId("chat-response-placeholder")
      .classList.contains("dispatch-defrag-reduced")
  ).toBe(false);
  expect(view.container.querySelector('[data-category="read"]')).not.toBeNull();
});

it("has a human label for every activity colour", () => {
  expect(Object.keys(ACTIVITY_LABELS).sort()).toEqual(
    Object.keys(ACTIVITY_COLORS).sort()
  );
  expect(Object.values(ACTIVITY_LABELS).every(Boolean)).toBe(true);
});

function tooltipFixture(compaction = false, reduced = false) {
  // jsdom has no layout; give the real event hit testing known cell rectangles.
  vi.stubGlobal("PointerEvent", MouseEvent);
  const view = render(
    <ResponsePlaceholderVisual
      cells={[
        { id: 0, slot: 0, rest: "read", category: "read", step: 0 },
        { id: 1, slot: 1, rest: "read", category: "read", step: 0 },
        { id: 2, slot: 2, rest: "read" },
      ]}
      pieces={[
        { key: "read", category: "read", label: "secret command", compaction },
      ]}
      reducedCells={reduced ? defragCells("reduced", ["checks"]) : undefined}
      textLength={500}
      onShowProgress={vi.fn()}
    />
  );
  const grid = view.getByRole("status");
  const rect = (left: number, width: number) => ({
    left,
    right: left + width,
    top: 10,
    bottom: 15,
    width,
    height: 5,
    x: left,
    y: 10,
    toJSON() {},
  });
  vi.spyOn(grid, "getBoundingClientRect").mockReturnValue(rect(0, 320));
  view.container
    .querySelectorAll<HTMLElement>("[data-defrag-cell]")
    .forEach((cell, i) => {
      vi.spyOn(cell, "getBoundingClientRect").mockReturnValue(rect(i * 7, 5));
    });
  return { ...view, grid };
}

it("hovers the whole colour run including gaps, centers its category and hides on muted cells", async () => {
  const view = tooltipFixture();
  fireEvent.pointerMove(view.grid, { clientX: 12.5, clientY: 15.5 });
  expect((await view.findByRole("tooltip")).textContent).toBe("Reading files");
  expect(
    view.container
      .querySelector("[aria-hidden=true][data-state]")
      ?.getAttribute("style")
  ).toContain("width: 12px");
  expect(view.container.querySelector("[title]")).toBeNull();
  fireEvent.pointerMove(view.grid, { clientX: 17, clientY: 12 });
  expect(view.queryByRole("tooltip")).toBeNull();
});

it("shows on touch and dismisses with an outside tap without blocking progress", async () => {
  const view = tooltipFixture();
  const touch = new MouseEvent("pointerup", {
    bubbles: true,
    clientX: 5,
    clientY: 12,
  });
  Object.defineProperty(touch, "pointerType", { value: "touch" });
  fireEvent(view.grid, touch);
  expect((await view.findByRole("tooltip")).textContent).toBe("Reading files");
  fireEvent.pointerDown(
    view.getByRole("button", { name: "Show progress text" })
  );
  expect(view.queryByRole("tooltip")).toBeNull();
});

it("names compaction rather than the shared checks category", async () => {
  const view = tooltipFixture(true);
  fireEvent.pointerMove(view.grid, { clientX: 5, clientY: 12 });
  expect((await view.findByRole("tooltip")).textContent).toBe("Compaction");
});

it("labels the reduced-motion compaction override even on previously muted pieces", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const view = tooltipFixture(false, true);
  fireEvent.pointerMove(view.grid, { clientX: 17, clientY: 12 });
  expect((await view.findByRole("tooltip")).textContent).toBe("Compaction");
});

it("dismisses a stationary tooltip when a new grid pass moves its group", async () => {
  const view = tooltipFixture();
  fireEvent.pointerMove(view.grid, { clientX: 5, clientY: 12 });
  await view.findByRole("tooltip");
  view.rerender(
    <ResponsePlaceholderVisual
      cells={defragCells("next-pass", [])}
      pieces={[]}
    />
  );
  expect(view.queryByRole("tooltip")).toBeNull();
});

it("moves blocks to offsets measured against the grid, not the block's own box", () => {
  // WebKit resolves a percentage translate against the cell's pixel-snapped
  // width, so a tween built from the exact width ended a pixel or more short
  // of the resting place and the block snapped sideways as it landed.
  const steps: Step[] = ["read", "edit", "think"].map((kind, i) => ({
    id: `step-${i}`,
    kind: kind as Step["kind"],
    label: kind,
    status: "ok",
    startedAt: i,
    endedAt: i + 1,
  }));
  const view = render(<ResponsePlaceholder seed="landing" steps={steps} />);
  const grid = view.getByRole("status");
  expect(grid.style.containerType).toBe("inline-size");
  const cells = [...grid.querySelectorAll<HTMLElement>("[data-defrag-cell]")];
  const tile = grid.querySelector<HTMLElement>("[style*='mask-size']")!;
  expect(tile.style.maskSize).toBe("3.125% 25%");
  expect(cells.length).toBeGreaterThan(0);
  for (const cell of cells) {
    // A 32-column grid and an 8px row pitch match the repeated background.
    expect(cell.style.transform).toMatch(
      /^translate\(calc\(\d+ \* 100cqw \/ 32\), calc\([0-3] \* 100cqw \/ 32\)\)$/
    );
  }
});

it("reserves a new turn's grid before starting the activity animation", () => {
  vi.useFakeTimers();
  const view = render(
    <ResponsePlaceholder seed="arrival" steps={[]} turnStartedAt={Date.now()} />
  );
  expect(view.getByRole("status")).toBeTruthy();
  expect(view.container.querySelector("[data-defrag-cell]")).toBeNull();
  act(() => vi.advanceTimersByTime(850));
  expect(view.container.querySelector("[data-defrag-cell]")).toBeTruthy();
});
