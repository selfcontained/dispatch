import {
  remotePlacement,
  RUNNER_WIRE_VERSION,
  type CheckoutCommand,
  type CheckoutCommandFile,
} from "@dispatch/runner-protocol";
import {
  placementOf,
  placementRunner,
  runnerIdFromWire,
  runnerIdToWire,
  samePlacement,
  type Placement,
  type Runner,
  type RunnerDescription,
  type Runners,
} from "@dispatch/runner-protocol/contract";
import type { RemoteRunnerService } from "../agents/remote/service.js";
import type { AgentRecord } from "../agents/types.js";
import { createLocalCheckoutRunner } from "./local.js";
import { createEnrolledCheckoutRunner } from "./enrolled/checkout.js";

export type CheckoutSession = Pick<
  AgentRecord,
  "id" | "cwd" | "worktreePath" | "workspacePath"
>;
export type LocalCheckoutRunner = {
  requestSession(
    request: {
      kind: "checkoutCommand";
      agentId: string;
      operation: CheckoutCommand;
    },
    binding: { checkout: CheckoutSession }
  ): Promise<{ value?: string | boolean }>;
};
export type CheckoutCommandRunners = {
  local: LocalCheckoutRunner;
  remote?: RemoteRunnerService;
};

export interface CheckoutRunner extends Runner {
  /** Guarded manifest reads stay on the existing checkout-command family until T14. */
  readManifest(
    operation: Extract<CheckoutCommand, { kind: "read" }>,
    signal?: AbortSignal
  ): Promise<CheckoutCommandFile | null>;
}

interface CheckoutDirectory extends Runners {
  for(placement: Placement): CheckoutRunner;
}

const localId = runnerIdFromWire("local");
const defaultPlacement = placementOf(localId);
const localDescription: RunnerDescription = {
  runnerId: localId,
  displayName: "Local",
  build: { version: "" },
  protocol: RUNNER_WIRE_VERSION,
  engines: [],
  capabilities: {},
};

/** Until T40, translate the stored locator at the boundary for each session. */
export function checkoutRunners(
  { local, remote }: CheckoutCommandRunners,
  agent: CheckoutSession
): {
  directory: CheckoutDirectory;
  placement: Placement;
} {
  const locator = remotePlacement(agent.cwd);
  const placement = locator
    ? placementOf(runnerIdFromWire(locator.runner))
    : defaultPlacement;
  const directory = {
    for(selected: Placement): CheckoutRunner {
      const boundAgent = samePlacement(selected, placement) ? agent : undefined;
      if (samePlacement(selected, defaultPlacement) && !(locator && boundAgent))
        return createLocalCheckoutRunner(local, boundAgent, localDescription);

      const id = placementRunner(selected);
      return createEnrolledCheckoutRunner(
        remote,
        runnerIdToWire(id),
        boundAgent ? locator : null,
        boundAgent,
        () => {
          return (
            remote
              ?.runnerDescriptions?.()
              .find((runner) => runner.runnerId === id) ?? {
              runnerId: id,
              displayName: runnerIdToWire(id),
              build: { version: "" },
              protocol: RUNNER_WIRE_VERSION,
              engines: [],
              capabilities: {},
            }
          );
        }
      );
    },
    list() {
      return [localDescription, ...(remote?.runnerDescriptions?.() ?? [])].map(
        (description) => ({
          description,
          placement: placementOf(description.runnerId),
        })
      );
    },
    defaultPlacement: () => defaultPlacement,
  } satisfies CheckoutDirectory;
  return { directory, placement };
}
