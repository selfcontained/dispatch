// Each binary mode loads only its own workload dependencies.
export const loadCheckoutWorker = () =>
  import("./workload/agents/checkout-worker.js");
export const loadLocalWorkspaceProbes = () =>
  import("./workload/agents/local-workspace-probes.js");
export const loadRunnerWorker = () =>
  import("./workload/terminal/runner-worker.js");
export const loadEnrollment = () =>
  import("./workload/agents/remote/enrollment.js");
export const loadWorkspacePrep = () =>
  import("./workload/agents/workspace-prep.js");
export const loadSessionFiles = () =>
  import("./workload/agents/remote/session-files.js");
export const loadCheckoutCommand = () =>
  import("./workload/agents/remote/checkout-command.js");
export const loadEngineHostWorker = () =>
  import("./workload/agents/remote/engine-capability-worker.js");
export const loadUpdateHandoff = () =>
  import("./workload/agents/remote/update-handoff.js");
export const loadUpdateTrial = () =>
  import("./workload/agents/remote/update-trial.js");
export const loadUpdateStageCli = () =>
  import("./workload/agents/remote/update-stage-cli.js");
export const loadRunner = () => import("./workload/agents/remote/runner.js");
export const loadHostSearchPath = () => import("./host/host-search-path.js");
export const loadEngineAvailability = () =>
  import("./workload/agents/engine-availability.js");
export { dispatchRunnerMode } from "./program.js";
