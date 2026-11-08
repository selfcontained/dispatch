// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { RoutingDiagnostic } from "@dispatch/shared";
import { RoutingDecisionDetails } from "./routing-decision";
afterEach(cleanup);
const diagnostic: RoutingDiagnostic = {
  turnId: 1,
  agentId: "agent",
  mode: "active",
  status: "ok",
  actual: "Thread",
  reason: "Recommendation applied",
  choice: "home_root",
  probabilities: [
    { value: "home_root", probability: 0.95 },
    { value: "initiating_discussion", probability: 0.05 },
  ],
  confidence: 0.81,
  latencyMs: 462,
  costUsd: 0.0001,
  costBasis: "uncached-estimate",
};
it("shows actual destination and separate choice/confidence override gates, with optional details", () => {
  render(
    <RoutingDecisionDetails diagnostic={diagnostic} agentName="Builder" />
  );
  const section = screen.getByRole("region", { name: "Routing for Builder" });
  expect(within(section).getByText("Thread")).toBeTruthy();
  expect(within(section).getByText("Router recommended Root")).toBeTruthy();
  expect(screen.getByText("Root preference")).toBeTruthy();
  expect(screen.getByText("Decision confidence")).toBeTruthy();
  expect(screen.getByText("95%")).toBeTruthy();
  expect(screen.getByText("81%")).toBeTruthy();
  expect(screen.queryByText("95.0%")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Decision details/ }));
  expect(screen.getByText("95.0%")).toBeTruthy();
  expect(screen.getByText("81.0% ✓")).toBeTruthy();
  expect(screen.getByText("Root · recommended")).toBeTruthy();
  expect(screen.queryByText("Input tokens")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Routing API usage/ }));
  expect(screen.getByText(/462 ms.*0.00010000.*uncached/)).toBeTruthy();
  expect(screen.getByText("Unavailable")).toBeTruthy();
});
it("keeps valid input and cache counts under the usage disclosure", () => {
  render(
    <RoutingDecisionDetails
      diagnostic={{
        ...diagnostic,
        costBasis: "cache-aware",
        inputTokens: 1000,
        cachedReadTokens: 200,
        cacheWriteTokens: 100,
      }}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: /Routing API usage/ }));
  expect(screen.getByText("1000")).toBeTruthy();
  expect(screen.getByText("200 / 100")).toBeTruthy();
});
it("reports a below-threshold default without presenting the model recommendation as applied", () => {
  render(
    <RoutingDecisionDetails
      diagnostic={{
        ...diagnostic,
        actual: "Root",
        choice: "initiating_discussion",
        confidence: 0.2,
        reason: "Below threshold; default preserved",
      }}
    />
  );
  expect(screen.getByText("Default kept")).toBeTruthy();
  expect(screen.getByText("Override requirements not met")).toBeTruthy();
  expect(screen.queryByText("Recommendation used")).toBeNull();
});
