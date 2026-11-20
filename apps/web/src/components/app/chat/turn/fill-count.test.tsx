// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import type { ActivityCategory } from "./activity-category";
import type { Step } from "./contracts";
import { FillCount, fillBlocks, fillMix, topFillMix } from "./fill-count";
import {
  ResponsePlaceholder,
  defragCells,
  defragHistory,
} from "./response-placeholder";

afterEach(cleanup);

const SEED = "fill-count-test";
const count = defragCells(SEED, []).length;
const reads = (n: number): ActivityCategory[] => Array(n).fill("read");

describe("defragHistory", () => {
  it("counts a fill only when the next step scatters the full grid", () => {
    expect(defragHistory(SEED, reads(count)).fills).toHaveLength(0);
    const once = defragHistory(SEED, reads(count + 1));
    expect(once.fills).toHaveLength(1);
    expect(once.fills[0]!.categories).toEqual(reads(count));
    expect(defragHistory(SEED, reads(3 * count + 1)).fills).toHaveLength(3);
  });

  it("does not count a compaction repack as a fill", () => {
    const repack = new Set([10, 20]);
    expect(defragHistory(SEED, reads(count), repack).fills).toHaveLength(0);
  });

  it("leaves the grid exactly as defragCells builds it", () => {
    const steps: ActivityCategory[] = Array.from(
      { length: 2 * count + 9 },
      (_, i) => (["read", "think", "edit", "dispatch"] as const)[i % 4]!
    );
    expect(defragHistory(SEED, steps).cells).toEqual(defragCells(SEED, steps));
  });
});

describe("fill mix", () => {
  const fill = (spec: [ActivityCategory, number][]) => ({
    categories: spec.flatMap(([c, n]) => Array<ActivityCategory>(n).fill(c)),
  });

  it("sums every lap, biggest group first", () => {
    const mix = fillMix([
      fill([
        ["read", 3],
        ["edit", 1],
      ]),
      fill([["edit", 4]]),
    ]);
    expect(mix).toEqual([
      { category: "edit", count: 5 },
      { category: "read", count: 3 },
    ]);
  });

  it("folds the long tail into other without touching the full mix", () => {
    const mix = fillMix([
      fill([
        ["read", 6],
        ["think", 5],
        ["edit", 4],
        ["git", 3],
        ["browser", 2],
        ["dev", 1],
      ]),
    ]);
    const top = topFillMix(mix);
    expect(top.map((s) => s.category)).toEqual([
      "read",
      "think",
      "edit",
      "git",
      "other",
    ]);
    expect(top.at(-1)!.count).toBe(3);
    expect(mix).toHaveLength(6);
  });

  it("allocates exactly the requested blocks, grouped in order", () => {
    const blocks = fillBlocks(
      [
        { category: "read", count: 50 },
        { category: "edit", count: 30 },
        { category: "git", count: 20 },
      ],
      12
    );
    expect(blocks).toHaveLength(12);
    expect(blocks.join(",")).toBe(
      [...reads(6), ...Array(4).fill("edit"), ...Array(2).fill("git")].join(",")
    );
  });
});

describe("placeholder fill count", () => {
  const steps = (n: number): Step[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `s${i}`,
      kind: "read",
      label: "Read",
      status: "ok",
      startedAt: i,
      endedAt: i + 1,
    }));

  it("shows nothing until the grid has filled", () => {
    // Settled steps add an implicit thinking piece, filling the grid exactly.
    const view = render(
      <ResponsePlaceholder seed={SEED} steps={steps(count - 1)} />
    );
    expect(view.queryByTestId("chat-response-fill-count")).toBeNull();
  });

  it("shows the laps first on the row, before the activity counts", () => {
    const view = render(
      <ResponsePlaceholder
        seed={SEED}
        steps={steps(2 * count + 1)}
        textLength={600}
      />
    );
    const chip = view.getByTestId("chat-response-fill-count");
    expect(chip.textContent).toBe("×2");
    expect(chip.getAttribute("aria-label")).toMatch(
      /^Filled 2 times, mostly reading files and /
    );
    expect(chip.parentElement!.firstElementChild).toBe(chip);
    expect(chip.parentElement!.lastElementChild).toBe(
      view.getByTestId("chat-response-activity-counts")
    );
  });
});

describe("FillCount", () => {
  it("toggles the breakdown on tap even though the tap also focuses it", () => {
    const view = render(
      <FillCount fills={[{ categories: reads(4) }, { categories: reads(4) }]} />
    );
    const chip = view.getByTestId("chat-response-fill-count");
    const tap = () => {
      fireEvent.pointerDown(chip, { pointerType: "touch" });
      fireEvent.pointerUp(chip, { pointerType: "touch" });
      fireEvent.focus(chip);
      fireEvent.click(chip);
    };
    tap();
    expect(chip.getAttribute("data-state")).not.toBe("closed");
    tap();
    expect(chip.getAttribute("data-state")).toBe("closed");
  });
});
