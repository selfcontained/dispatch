import { isOpaqueId } from "@dispatch/runner-protocol";
import { sameRunner, type Placement } from "@dispatch/runner-protocol/contract";
import {
  recordedCheckoutDirectory,
  resolveLaunchLocation,
  type WorkspaceTargetAgent,
} from "../agents/workspace-target.js";
import {
  controllerPlacement,
  placementForRunner,
  runnerIdForPlacement,
} from "./placement.js";

/** A saved launch target can await project selection. */
export type Location =
  | { runner: string; path: string }
  | { runner: string; projectId: string | null };

type StoredLocation = Location;

export const storedLocation = Symbol("saved launch location");

export type SavedTarget = {
  directory: string;
  projectId?: string | null;
  [storedLocation]?: StoredLocation;
};

/** A named folder and a project have distinct persisted location shapes. */
export function sessionFolderLocation(
  agent: { placement?: Placement; projectId?: string | null },
  path: string
): Location {
  const placement = agent.placement ?? controllerPlacement;
  const runner = runnerIdForPlacement(placement);
  return sameRunner(placement, controllerPlacement)
    ? { runner, path }
    : { runner, projectId: agent.projectId ?? null };
}

/** A caller inherits a recorded folder or a project on its runner. The
 * prepared cwd stays available when a project has no recorded local path. */
export function sessionLaunchTarget(
  agent: WorkspaceTargetAgent & { cwd: string; projectId?: string | null }
) {
  const location = sessionFolderLocation(
    agent,
    recordedCheckoutDirectory(agent) ?? agent.cwd
  );
  return {
    directory: "path" in location ? location.path : agent.cwd,
    location,
  };
}

export function targetPlacement(target: SavedTarget): Placement {
  const runner = target[storedLocation]?.runner;
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
  const callerPlacement = caller.placement ?? controllerPlacement;
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
  const previous = options.previous;
  const placement =
    options.runner !== undefined
      ? placementForRunner(options.runner)
      : previous && !options.directorySupplied
        ? targetPlacement(previous)
        : targetPlacement({ directory });
  const runner = runnerIdForPlacement(placement);
  if (sameRunner(placement, controllerPlacement)) {
    const path = resolveLaunchLocation(options.projectRoot ?? directory);
    return { directory: path, [storedLocation]: { runner, path } };
  }
  return {
    directory: "",
    [storedLocation]: { runner, projectId: options.projectId ?? null },
  };
}

/** A saved enrolled project gains a directory when its runner prepares the checkout. */
export function savedLaunchTarget(
  target: SavedTarget & { useWorktree: boolean }
) {
  const placement = targetPlacement(target);
  const location = target[storedLocation];
  if (sameRunner(placement, controllerPlacement))
    return {
      placement,
      cwd: location && "path" in location ? location.path : target.directory,
    };

  const projectId =
    location && "projectId" in location ? location.projectId : target.projectId;
  if (!projectId)
    throw new Error("A project is required to launch on this runner.");
  return {
    cwd: "",
    placement,
    projectId,
    repository: target.useWorktree
      ? {}
      : { checkout: { kind: "default" as const } },
  };
}

export function normalizeSavedDirectory(
  directory: string,
  location?: Location | string
): string {
  const placement =
    typeof location === "string"
      ? placementForRunner(location)
      : targetPlacement({ directory, [storedLocation]: location });
  return sameRunner(placement, controllerPlacement)
    ? resolveLaunchLocation(directory)
    : "";
}

/** Keep the internal location through snapshots and out of existing JSON APIs. */
export function mapSavedLocation<T>(row: Record<string, unknown>): T {
  const { location, ...record } = row;
  return (location ? { ...record, [storedLocation]: location } : record) as T;
}

export function requestedRunnerPlacement(body: {
  runner?: unknown;
}): Placement | undefined {
  const { runner } = body;
  if (runner === undefined) return undefined;
  if (!isOpaqueId(runner)) throw new Error("Invalid runner.");
  return placementForRunner(runner);
}
