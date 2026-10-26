// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { TaskColumn } from "@/hooks/use-tasks";
import { ColumnCapacity } from "./task-column-capacity";
afterEach(cleanup);
it.each([
  [null, 7, "7", "unlimited"],
  [3, 2, "2 / 3", "limit 3"],
  [3, 3, "3 / 3", "Full"],
  [3, 4, "4 / 3", "Over limit"],
])(
  "renders authoritative occupancy for capacity %s and count %s",
  (capacity, activeTaskCount, display, label) => {
    render(
      <ColumnCapacity
        column={
          {
            id: "ready",
            projectId: "p1",
            position: 0,
            isDone: false,
            trigger: null,
            createdAt: "2026-01-01",
            updatedAt: "2026-01-01",
            key: "ready",
            name: "Ready",
            capacity,
            activeTaskCount,
          } as TaskColumn
        }
      />
    );
    expect(
      screen.getByTestId("column-capacity-ready").getAttribute("aria-label")
    ).toContain(label);
    expect(screen.getByText(display)).toBeTruthy();
  }
);
