import { vi } from "vitest";

// Build the fixture's entry inputs only when the suite first imports a consumer.
// Its module mocks then wrap the same workload instances that the adapter uses.
vi.mock("../../src/runners/in-process.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/runners/in-process.js")>();
  const workload =
    await import("../../../../packages/runner/src/workload/agents/checkout-worker.js");
  const { createLaunchFolderProbes } =
    await import("../../../../packages/runner/src/workload/agents/local-workspace-probes.js");
  const privacy = await import("../../src/shared/mac-path-privacy.js");
  await actual.loadInProcessPorts(
    async () => workload,
    createLaunchFolderProbes((path, home) =>
      privacy.shouldSkipAutomaticMacPathProbe(path, home)
    )
  );
  return actual;
});
