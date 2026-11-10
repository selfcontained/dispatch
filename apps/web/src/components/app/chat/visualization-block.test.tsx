// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VisualizationBlock } from "./visualization-block";
beforeAll(() =>
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
);
afterEach(cleanup);
const base = {
  version: 1,
  title: "Results",
  unit: "items",
  dataKind: "synthetic",
  type: "scatter",
  xLabel: "Effort",
  xUnit: "hours",
  series: [{ id: "result", label: "Result", color: "cyan" }],
  points: [
    { label: "Batch A", x: 2.125, values: [123456.75] },
    { label: "Batch B", x: 3, values: [null] },
  ],
};
describe("visualization rendering", () => {
  it("renders exact scatter coordinates, units and missing values", () => {
    render(<VisualizationBlock kind="chart" data={base} />);
    fireEvent.click(screen.getByText("View exact data"));
    expect(screen.getByText("2.125")).toBeTruthy();
    expect(screen.getByText("123456.75")).toBeTruthy();
    expect(screen.getByText("x (hours)")).toBeTruthy();
    expect(screen.getByText("Missing")).toBeTruthy();
    expect(screen.queryByText("DESIGN REVIEW")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("handles unsupported versions and empty data", () => {
    const { rerender } = render(
      <VisualizationBlock kind="chart" data={{ ...base, version: 99 }} />
    );
    expect(screen.getByRole("status").textContent).toContain(
      "unsupported version"
    );
    rerender(
      <VisualizationBlock kind="chart" data={{ ...base, points: [] }} />
    );
    expect(screen.getByText("No data to display.")).toBeTruthy();
  });
  it("exposes exact metric values and service metadata without review controls", () => {
    render(
      <VisualizationBlock
        kind="metric"
        data={{
          version: 1,
          title: "Exact",
          unit: "items",
          dataKind: "measured",
          value: 123456789.125,
          delivery: "queue",
        }}
      />
    );
    expect(screen.getByText("Exact value: 123456789.125 items")).toBeTruthy();
  });
  it("heatmap has labeled exact cells including null", () => {
    render(
      <VisualizationBlock
        kind="chart"
        data={{
          ...base,
          type: "heatmap",
          xUnit: undefined,
          points: [
            { label: "A", values: [42] },
            { label: "B", values: [null] },
          ],
        }}
      />
    );
    expect(screen.getAllByText("42").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Missing").length).toBeGreaterThan(0);
  });
});

it("does not invent cumulative totals after a missing waterfall delta", () => {
  render(
    <VisualizationBlock
      kind="chart"
      data={{
        version: 1,
        title: "Changes",
        unit: "items",
        dataKind: "synthetic",
        type: "waterfall",
        xLabel: "Step",
        series: [{ id: "delta", label: "Delta", color: "cyan" }],
        points: [
          { label: "Initial", values: [10] },
          { label: "Unknown", values: [null] },
          { label: "Later", values: [3] },
        ],
      }}
    />
  );
  fireEvent.click(screen.getByText("View exact data"));
  const row = screen.getByRole("row", { name: /Later/ });
  expect(row.textContent).toContain("3MissingMissing");
});
