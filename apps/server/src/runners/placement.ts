import {
  placementOf,
  placementRunner,
  runnerIdFromWire,
  runnerIdToWire,
  sameRunner,
  type Placement,
} from "@dispatch/runner-protocol/contract";

export const LOCAL_RUNNER_ID = runnerIdFromWire("local");
export const controllerPlacement = placementOf(LOCAL_RUNNER_ID);

/** The database stores the runner ID as text. */
export function placementFromRow(row: { runner_id: string }): Placement {
  return placementOf(runnerIdFromWire(row.runner_id));
}

export function placementForRunner(runnerId: string): Placement {
  return placementOf(runnerIdFromWire(runnerId));
}

export function runnerIdForPlacement(placement: Placement): string {
  return runnerIdToWire(placementRunner(placement));
}

/** The legacy update and watch services address enrolled runners by wire ID. */
export function enrolledRunnerId(placement: Placement): string | undefined {
  return sameRunner(placement, controllerPlacement)
    ? undefined
    : runnerIdForPlacement(placement);
}

/** The placement `enrolledRunnerId` names: an enrolled runner, else the local one. */
export function placementForEnrolledId(runnerId: string | null | undefined) {
  return runnerId == null ? controllerPlacement : placementForRunner(runnerId);
}

export function isOnEnrolledRunner(placement: Placement, runnerId: string) {
  return (
    !sameRunner(placement, controllerPlacement) &&
    sameRunner(placement, placementForRunner(runnerId))
  );
}

/** Runner address for session services before the runtime has opened its connection. */
export function sessionLocation(placement: Placement) {
  return enrolledRunnerId(placement) ?? null;
}
