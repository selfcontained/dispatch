import { vi } from "vitest";

// Build the fixture's entry inputs only when the suite first imports a consumer.
// Its module mocks then wrap the same workload instances that the adapter uses.
vi.mock("../../src/runners/in-process.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/runners/in-process.js")>();
  const workload = await import("../../src/agents/checkout-worker.js");
  const { parseEngineCapabilityResult } =
    await import("../../src/agents/remote/engine-capability-result.js");
  await actual.loadInProcessPorts(
    async () => workload,
    parseEngineCapabilityResult
  );
  return actual;
});
