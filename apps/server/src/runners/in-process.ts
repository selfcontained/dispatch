import type { InProcessPorts } from "@dispatch/runner-protocol/in-process";
import { toPersonaDefinition } from "../personas/definition.js";

type Ports = InProcessPorts<Buffer>;

type WorkloadExports = Omit<
  Ports,
  "checkoutWorkload" | "parseEngineCapabilityResult"
> & {
  createCheckoutWorkload(inputs: {
    parseDefinition: typeof toPersonaDefinition;
  }): Ports["checkoutWorkload"];
};

/** Constructed once for the server process after its shell environment is restored. */
export function composeInProcessPorts(
  workload: WorkloadExports,
  parseEngineCapabilityResult: Ports["parseEngineCapabilityResult"]
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
    checkoutWorkload: createCheckoutWorkload({
      parseDefinition: toPersonaDefinition,
    }),
    githubWorkload,
    workspaceWorkload,
    sessionFilesWorkload,
    localEnginePort,
    readCommandGuard,
    hostCommand,
    parseEngineCapabilityResult,
  };
}

let ports: Ports | undefined;

export async function loadInProcessPorts(
  load: () => Promise<WorkloadExports>,
  parse: Ports["parseEngineCapabilityResult"]
) {
  ports = composeInProcessPorts(await load(), parse);
}

export function inProcessPorts(): Ports {
  if (!ports) throw new Error("In-process runner ports have not been loaded.");
  return ports;
}
