import { describe, expect, it } from "vitest";

import type { Step } from "./contracts";
import { activityCategory, type ActivityCategory } from "./activity-category";
import {
  blendWrites,
  defragCells,
  sequenceCategories,
} from "./response-placeholder";

const step = (kind: string, label?: string, command?: string): Step => ({
  id: `${kind}:${label ?? ""}`,
  kind,
  label,
  status: "ok",
  startedAt: 0,
  ...(command ? { detail: { input: { command } } } : {}),
});

describe("activityCategory", () => {
  it.each([
    [step("think"), "think"],
    [step("note"), "think"],
    [step("edit"), "edit"],
    [step("read"), "read"],
    [step("search"), "read"],
    [step("execute", "mcp.dispatch.post"), "dispatch"],
    [step("other", "mcp__dispatch__task_update"), "dispatch"],
    [step("execute", "mcp.dispatch.repo_dev_up"), "dev"],
    [step("execute", "mcp.playwright.browser_click"), "browser"],
    [step("other", "mcp__linear__get_issue"), "other"],
    [step("execute", "", "git status --short"), "git"],
    [step("execute", "", "gh pr checks 1490"), "git"],
    [step("execute", "", "sed -n '1,80p' a.ts"), "read"],
    [step("execute", "", "sed -i 's/a/b/' a.ts"), "edit"],
    [step("execute", "", "python3 - <<'PY'"), "edit"],
    [step("execute", "", 'export PATH="x:$PATH"; pnpm run check'), "checks"],
    [step("execute", "", "cd apps/web && npx vitest run"), "checks"],
    [step("execute", "", "curl -s localhost:6767/health"), "dev"],
    [step("execute", "", "mkdir -p out"), "other"],
  ])("files %o as %s", (s, expected) => {
    expect(activityCategory(s)).toBe(expected);
  });
});

describe("defragCells", () => {
  const cats = (n: number): ActivityCategory[] =>
    Array.from({ length: n }, (_, i) => (i % 2 ? "read" : "think"));

  it("packs from the front with like kinds grouped, first-seen first", () => {
    const steps: ActivityCategory[] = [
      "think",
      "read",
      "git",
      "read",
      "think",
      "git",
      "read",
    ];
    const cells = defragCells("blk_1", steps);
    const run = cells
      .filter((c) => c.step !== undefined)
      .sort((a, b) => a.slot - b.slot);
    expect(run.map((c) => c.slot)).toEqual([...Array(7).keys()]);
    expect(run.map((c) => c.category)).toEqual([
      "think",
      "think",
      "read",
      "read",
      "read",
      "git",
      "git",
    ]);
    // Within a group, pieces keep the order their steps ran in.
    expect(run.map((c) => c.step)).toEqual([0, 4, 1, 3, 6, 2, 5]);
  });

  it("never puts two blocks in one slot", () => {
    const cells = defragCells("blk_2", cats(40));
    expect(new Set(cells.map((c) => c.slot)).size).toBe(cells.length);
  });

  it("differs from turn to turn but holds still within one", () => {
    const a = defragCells("blk_a", cats(3)).map((c) => c.slot);
    expect(defragCells("blk_a", cats(3)).map((c) => c.slot)).toEqual(a);
    expect(defragCells("blk_b", cats(3)).map((c) => c.slot)).not.toEqual(a);
  });

  it("scatters again and starts a new pass once the grid is full", () => {
    const full = defragCells("blk_3", cats(500));
    const count = full.length;
    // The grid holds `count` blocks; step `count` begins pass two.
    const atCapacity = defragCells("blk_3", cats(count));
    expect(atCapacity.every((c) => c.step !== undefined)).toBe(true);
    const nextPass = defragCells("blk_3", cats(count + 3));
    const written = nextPass.filter((c) => c.step !== undefined);
    expect(written.map((c) => c.step).sort((a, b) => a! - b!)).toEqual([
      count,
      count + 1,
      count + 2,
    ]);
    expect(written.map((c) => c.slot).sort((a, b) => a - b)).toEqual([0, 1, 2]);
    // Blocks from the last pass keep a trace of their colour while scattered.
    expect(
      nextPass.filter(
        (c) => c.step === undefined && (c.rest === "think" || c.rest === "read")
      )
    ).toHaveLength(count - 3);
    expect(new Set(nextPass.map((c) => c.slot)).size).toBe(count);
    // However long the turn runs, the current pass stays partly packed.
    expect(full.filter((c) => c.step !== undefined).length).toBe(
      500 % count || count
    );
  });

  it("places a piece of the step's own kind while one is unsorted", () => {
    const start = defragCells("blk_4", []);
    const thinking = start.filter((c) => c.rest === "think").length;
    expect(thinking).toBeGreaterThan(0);
    const cells = defragCells("blk_4", Array(thinking).fill("think"));
    // Every placed piece was a thinking piece to begin with.
    const placed = new Set(
      cells.filter((c) => c.step !== undefined).map((c) => c.id)
    );
    const wereThinking = new Set(
      start.filter((c) => c.rest === "think").map((c) => c.id)
    );
    expect(placed).toEqual(wereThinking);
  });

  it("recolours another unsorted piece once its own kind runs out", () => {
    const start = defragCells("blk_5", []);
    const checks = start.filter((c) => c.rest === "checks").length;
    const cells = defragCells("blk_5", Array(checks + 2).fill("checks"));
    const placed = cells.filter((c) => c.step !== undefined);
    expect(placed).toHaveLength(checks + 2);
    expect(placed.every((c) => c.rest === "checks")).toBe(true);
  });

  it("does not start a new pass until every piece is placed", () => {
    const count = defragCells("blk_6", []).length;
    const full = defragCells("blk_6", cats(count));
    expect(full.every((c) => c.step !== undefined)).toBe(true);
    expect(full.map((c) => c.slot).sort((a, b) => a - b)).toEqual([
      ...Array(count).keys(),
    ]);
  });
});

describe("blendWrites", () => {
  it("spreads text already written evenly between the steps", () => {
    expect(blendWrites(3, 2)).toBe("sswsw");
    expect(blendWrites(4, 0)).toBe("ssss");
    expect(blendWrites(0, 3)).toBe("www");
    const mixed = blendWrites(10, 4);
    expect(mixed.replace(/w/g, "")).toHaveLength(10);
    expect(mixed.replace(/s/g, "")).toHaveLength(4);
  });

  it("reads the order back as categories, writing as its own kind", () => {
    expect(sequenceCategories("swsw", ["read", "git"])).toEqual([
      "read",
      "write",
      "git",
      "write",
    ]);
  });
});

it("restarts packing for compaction without scattering or overlapping existing blocks", () => {
  const categories: ActivityCategory[] = Array.from({ length: 20 }, (_, i) =>
    i % 2 ? "read" : "think"
  );
  const before = defragCells("repack", categories);
  const packed = defragCells(
    "repack",
    [...categories, "checks"],
    new Set([20])
  );
  expect(packed.map((cell) => cell.id)).toEqual(before.map((cell) => cell.id));
  expect(new Set(packed.map((cell) => cell.slot)).size).toBe(packed.length);
  expect(
    packed
      .filter((cell) => cell.step !== undefined)
      .map((cell) => [cell.slot, cell.category])
  ).toEqual([[0, "checks"]]);
  expect(
    packed.filter((cell) => cell.slot !== before[cell.id]!.slot).length
  ).toBeLessThanOrEqual(2);
  const resumed = defragCells(
    "repack",
    [...categories, "checks", "read"],
    new Set([20])
  );
  expect(
    resumed
      .filter((cell) => cell.step !== undefined)
      .sort((a, b) => a.slot - b.slot)
      .map((cell) => cell.category)
  ).toEqual(["checks", "read"]);
});
