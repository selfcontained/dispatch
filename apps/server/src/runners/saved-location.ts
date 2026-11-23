import {
  MANAGED_WORKSPACE,
  remotePlacement,
  workspaceLocator,
} from "@dispatch/runner-protocol";
import { sameRunner, type Placement } from "@dispatch/runner-protocol/contract";
import { resolveLaunchLocation } from "../agents/workspace-target.js";
import {
  controllerPlacement,
  placementForRunner,
  runnerIdForPlacement,
} from "./placement.js";

/** A null project retains a legacy unscoped locator or an unresolved folder save. */
export type Location =
  | { runner: string; path: string }
  | { runner: string; projectId: string | null };

type StoredLocation = Location & { legacy?: true };

export const storedLocation = Symbol("saved launch location");

export type SavedTarget = {
  directory: string;
  projectId?: string | null;
  [storedLocation]?: StoredLocation;
};

export function targetPlacement(target: SavedTarget): Placement {
  const runner =
    target[storedLocation]?.runner ?? remotePlacement(target.directory)?.runner;
  return runner === undefined
    ? controllerPlacement
    : placementForRunner(runner);
}

/** A supplied folder selects the controller; an omitted directory uses the
 * caller's placement and, when needed, the caller's project. */
export function defaultSavedTarget<T extends SavedTarget & { runner?: string }>(
  input: T,
  caller: { cwd: string; projectId?: string | null; placement?: Placement },
  defaultDirectory?: boolean
): T {
  const callerPlacement =
    caller.placement ?? targetPlacement({ directory: caller.cwd });
  const placement =
    input.runner !== undefined
      ? placementForRunner(input.runner)
      : defaultDirectory
        ? callerPlacement
        : targetPlacement(input);
  const inheritProject = defaultDirectory
    ? !sameRunner(placement, controllerPlacement) ||
      !sameRunner(callerPlacement, controllerPlacement)
    : !sameRunner(placement, controllerPlacement) &&
      sameRunner(placement, callerPlacement);
  return {
    ...input,
    runner: runnerIdForPlacement(placement),
    projectId:
      input.projectId === undefined && inheritProject
        ? caller.projectId
        : input.projectId,
  };
}

/** Decode a saved target without contacting the machine, even when it is offline. */
export function resolveSavedTarget(
  directory: string,
  options: {
    runner?: string;
    previous?: SavedTarget;
    projectId?: string | null;
    projectRoot?: string;
    directorySupplied?: boolean;
  } = {}
): SavedTarget & { [storedLocation]: StoredLocation } {
  const locator = remotePlacement(directory);
  const previous = options.previous;
  const placement =
    options.runner !== undefined
      ? placementForRunner(options.runner)
      : previous && !options.directorySupplied
        ? targetPlacement(previous)
        : targetPlacement({ directory });
  const runner = runnerIdForPlacement(placement);
  if (sameRunner(placement, controllerPlacement)) {
    const path = resolveLaunchLocation(
      options.projectRoot ?? (locator ? "." : directory)
    );
    return { directory: path, [storedLocation]: { runner, path } };
  }
  const workspace =
    locator && sameRunner(placementForRunner(locator.runner), placement)
      ? locator.workspace
      : MANAGED_WORKSPACE;
  const directoryOnRunner = workspaceLocator({ runner, workspace });
  const legacy =
    (previous?.directory === directoryOnRunner &&
      (previous[storedLocation]?.legacy || !previous[storedLocation])) ||
    (locator &&
      !options.projectId &&
      sameRunner(placementForRunner(locator.runner), placement));
  return {
    directory: directoryOnRunner,
    [storedLocation]: {
      runner,
      projectId: options.projectId ?? null,
      ...(legacy && { legacy: true }),
    },
  };
}

/** Compatibility projection for the launcher until it accepts a Location. */
export function savedLaunchTarget(
  target: SavedTarget & { useWorktree: boolean }
) {
  const placement = targetPlacement(target);
  const location = target[storedLocation];
  if (sameRunner(placement, controllerPlacement))
    return {
      cwd: location && "path" in location ? location.path : target.directory,
    };

  const runner = runnerIdForPlacement(placement);
  const locator = remotePlacement(target.directory);
  const workspace =
    locator && sameRunner(placementForRunner(locator.runner), placement)
      ? locator.workspace
      : MANAGED_WORKSPACE;
  const projectId =
    location && "projectId" in location ? location.projectId : target.projectId;
  if (location && !location.legacy && !projectId)
    throw new Error("A project is required to launch on this runner.");
  return {
    cwd: workspaceLocator({ runner, workspace }),
    ...(projectId &&
    location &&
    !location.legacy &&
    workspace === MANAGED_WORKSPACE
      ? {
          projectId,
          repository: target.useWorktree
            ? {}
            : { checkout: { kind: "default" as const } },
        }
      : {}),
  };
}

export function sameSavedCheckout(a: SavedTarget, b: SavedTarget): boolean {
  return (
    sameRunner(targetPlacement(a), targetPlacement(b)) &&
    remotePlacement(a.directory)?.workspace ===
      remotePlacement(b.directory)?.workspace
  );
}

export function hasSavedLocator(directory: string): boolean {
  return remotePlacement(directory) !== null;
}

export function normalizeSavedDirectory(directory: string): string {
  return resolveLaunchLocation(directory);
}

/** Keep the internal location through snapshots and out of existing JSON APIs. */
export function mapSavedLocation<T>(row: Record<string, unknown>): T {
  const { location, ...record } = row;
  return (location ? { ...record, [storedLocation]: location } : record) as T;
}
