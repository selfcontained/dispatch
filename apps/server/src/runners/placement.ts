import { remotePlacement } from "@dispatch/runner-protocol";
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

/** Older read callers may only have the v1 session locator. */
export function checkoutReadPlacement(
  cwd: string | null | undefined
): Placement {
  const locator = cwd && remotePlacement(cwd);
  return locator ? placementForRunner(locator.runner) : controllerPlacement;
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

export function isOnEnrolledRunner(placement: Placement, runnerId: string) {
  return (
    !sameRunner(placement, controllerPlacement) &&
    sameRunner(placement, placementForRunner(runnerId))
  );
}

/** Until the legacy connection service drops workspace gates, retain the
 * workspace from the locator while selecting the runner from the record.
 */
export function legacySessionLocation(agent: {
  placement: Placement;
  cwd: string;
}) {
  const runner = enrolledRunnerId(agent.placement);
  const locator = runner === undefined ? null : remotePlacement(agent.cwd);
  return runner !== undefined && locator
    ? { runner, workspace: locator.workspace }
    : null;
}
