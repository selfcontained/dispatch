// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { RoutingDiagnostic } from "@dispatch/shared";
import { RoutingDecision, routingLabel } from "./routing-decision";
afterEach(cleanup);
const diagnostic: RoutingDiagnostic = {
  turnId: 1,
  agentId: "agent",
  mode: "active",
  status: "ok",
  actual: "Thread",
  reason: "Recommendation applied",
  choice: "home_root",
  probabilities: [{ value: "home_root", probability: 0.95 }],
  confidence: 0.81,
  latencyMs: 462,
  costUsd: 0.0001,
  costBasis: "uncached-estimate",
};
it("labels active, explicit, shadow and fallback outcomes", () => {
  expect(routingLabel(diagnostic)).toBe("Thread");
  expect(
    routingLabel({ ...diagnostic, reason: "Explicit route preserved" })
  ).toBe("Kept thread");
  expect(routingLabel({ ...diagnostic, mode: "shadow" })).toBe("Shadow: Root");
  expect(routingLabel({ ...diagnostic, status: "timeout" })).toBe(
    "Fallback: Thread"
  );
});
it("opens evidence with separate actual/model choice, probabilities, confidence and estimate assumption", () => {
  render(<RoutingDecision diagnostic={diagnostic} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Routing details: Thread" })
  );
  expect(screen.getByText("Actual route")).toBeTruthy();
  expect(screen.getByText("95.0%")).toBeTruthy();
  expect(screen.getByText("0.810")).toBeTruthy();
  expect(screen.getByText("Est. cost · uncached")).toBeTruthy();
  expect(screen.getByText("Cache")).toBeTruthy();
  expect(
    screen.queryByText(/assumes all input|No written model|not billing/)
  ).toBeNull();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByText("Actual route")).toBeNull();
});

it("shows actual sanitized cache counts when available without footer prose", () => {
  render(
    <RoutingDecision
      diagnostic={{
        ...diagnostic,
        costBasis: "cache-aware",
        inputTokens: 1000,
        cachedReadTokens: 200,
        cacheWriteTokens: 100,
      }}
    />
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Routing details: Thread" })
  );
  expect(screen.getByText("1000")).toBeTruthy();
  expect(screen.getByText("200")).toBeTruthy();
  expect(screen.getByText("100")).toBeTruthy();
  expect(screen.queryByText("Cache")).toBeNull();
});
