import type { InProcessPorts } from "@dispatch/runner-protocol/in-process";
import { toPersonaDefinition } from "../personas/definition.js";

type Ports = InProcessPorts<Buffer>;

type WorkloadExports = Omit<Ports, "checkoutWorkload" | "launchProbes"> & {
  createCheckoutWorkload(inputs: {
    parseDefinition: typeof toPersonaDefinition;
  }): Ports["checkoutWorkload"];
};

/** Constructed once for the server process after its shell environment is restored. */
export function composeInProcessPorts(
  workload: WorkloadExports,
  launchProbes: Ports["launchProbes"]
): Ports {
  const {
    createCheckoutWorkload,
    githubWorkload,
    workspaceWorkload,
    sessionFilesWorkload,
    localEnginePort,
    readCommandGuard,
    hostCommand,
  } = workload;
  return {
    launchProbes,
    checkoutWorkload: createCheckoutWorkload({
      parseDefinition: toPersonaDefinition,
    }),
    githubWorkload,
    workspaceWorkload,
    sessionFilesWorkload,
    localEnginePort,
    readCommandGuard,
    hostCommand,
  };
}

let ports: Ports | undefined;

export async function loadInProcessPorts(
  load: () => Promise<WorkloadExports>,
  launchProbes: Ports["launchProbes"]
) {
  ports = composeInProcessPorts(await load(), launchProbes);
}

export function inProcessPorts(): Ports {
  if (!ports) throw new Error("In-process runner ports have not been loaded.");
  return ports;
}
