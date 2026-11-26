import type { InProcessPorts } from "@dispatch/runner-protocol/in-process";

type Ports = InProcessPorts<Buffer>;

type WorkloadExports = Omit<
  Ports,
  "checkoutWorkload" | "parseEngineCapabilityResult" | "launchProbes"
> & {
  createCheckoutWorkload(): Ports["checkoutWorkload"];
};

/** Constructed once for the server process after its shell environment is restored. */
export function composeInProcessPorts(
  workload: WorkloadExports,
  parseEngineCapabilityResult: Ports["parseEngineCapabilityResult"],
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
    checkoutWorkload: createCheckoutWorkload(),
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
  parse: Ports["parseEngineCapabilityResult"],
  launchProbes: Ports["launchProbes"]
) {
  ports = composeInProcessPorts(await load(), parse, launchProbes);
}

export function inProcessPorts(): Ports {
  if (!ports) throw new Error("In-process runner ports have not been loaded.");
  return ports;
}
