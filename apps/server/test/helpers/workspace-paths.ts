// Test wiring for standalone workload functions; production supplies these ports.
import { inferRepositoryUrl } from "../../../../packages/runner/src/workload/agents/checkout-worker.js";
import { launchDirectory } from "../../src/agents/workspace-launch.js";
import {
  resolvePath as readPath,
  resolveLaunchDirectory as launchPath,
} from "../../../../packages/runner/src/workload/agents/workspace.js";
export const resolvePath = (
  raw: string,
  options?: Parameters<typeof readPath>[2]
) => readPath(raw, inferRepositoryUrl, options);
export const resolveLaunchDirectory = (raw: string) =>
  launchPath(raw, launchDirectory, inferRepositoryUrl);
