// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Step } from "./contracts";
import { StepRow } from "./step-row";

afterEach(cleanup);

const T0 = 1_700_000_000_000;

const running: Step = {
  id: "s1",
  kind: "execute",
  label: "bash",
  status: "running",
  startedAt: T0,
  detail: { input: { command: "pnpm test" }, terminalOutput: null },
};

const settled: Step = {
  ...running,
  status: "ok",
  endedAt: T0 + 800,
  durMs: 800,
  detail: { input: { command: "pnpm test" }, terminalOutput: "42 passed\n" },
};

describe("StepRow fold", () => {
  it("keeps showing the body it was open on while it folds after settling", () => {
    const { rerender } = render(
      <StepRow step={running} open onToggle={() => {}} maskClass="" />
    );
    expect(screen.getAllByText(/pnpm test/).length).toBeGreaterThan(0);
    // The result lands and the row closes in the same commit: the fold
    // still shows the command it was open on, not the output.
    rerender(
      <StepRow step={settled} open={false} onToggle={() => {}} maskClass="" />
    );
    // The row summary and the frozen body both carry the command.
    expect(screen.getAllByText(/pnpm test/).length).toBe(2);
    expect(screen.queryByText(/42 passed/)).toBeNull();
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
      "false"
    );
  });
});
