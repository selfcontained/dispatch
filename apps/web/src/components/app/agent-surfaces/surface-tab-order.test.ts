import { describe, expect, it } from "vitest";

import {
  mergeSurfaceTabOrder,
  moveEarlier,
  moveLater,
} from "@/components/app/agent-surfaces/surface-tab-order";

describe("mergeSurfaceTabOrder", () => {
  it("keeps the stored order for tabs that still exist", () => {
    expect(mergeSurfaceTabOrder(["a", "b", "c"], ["c", "a", "b"])).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("appends new server tabs the user hasn't reordered, in server order", () => {
    expect(mergeSurfaceTabOrder(["a", "b", "c"], ["b"])).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("drops stored ids the server no longer has", () => {
    expect(mergeSurfaceTabOrder(["a", "b"], ["z", "b", "a"])).toEqual([
      "b",
      "a",
    ]);
  });

  it("falls back to server order when nothing is stored", () => {
    expect(mergeSurfaceTabOrder(["a", "b", "c"], [])).toEqual(["a", "b", "c"]);
  });
});

describe("moveEarlier / moveLater", () => {
  it("swaps with the previous neighbor", () => {
    expect(moveEarlier(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
  });

  it("is a no-op at the start of the list", () => {
    expect(moveEarlier(["a", "b", "c"], "a")).toEqual(["a", "b", "c"]);
  });

  it("swaps with the next neighbor", () => {
    expect(moveLater(["a", "b", "c"], "b")).toEqual(["a", "c", "b"]);
  });

  it("is a no-op at the end of the list", () => {
    expect(moveLater(["a", "b", "c"], "c")).toEqual(["a", "b", "c"]);
  });

  it("is a no-op for an unknown id", () => {
    expect(moveEarlier(["a", "b"], "z")).toEqual(["a", "b"]);
    expect(moveLater(["a", "b"], "z")).toEqual(["a", "b"]);
  });
});
