import {
  placementOf,
  runnerIdFromWire,
} from "@dispatch/runner-protocol/contract";

export const localAgentPlacement = placementOf(runnerIdFromWire("local"));
