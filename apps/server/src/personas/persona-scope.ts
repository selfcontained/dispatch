import path from "node:path";
import {
  RunnerCallError,
  pathFromWire,
  displayPath,
  sameRunner,
  type Placement,
  type Res,
} from "@dispatch/runner-protocol/contract";
import type { AgentManager, AgentRecord } from "../agents/manager.js";
import {
  runnerDirectory,
  type CheckoutCommandRunners,
} from "../runners/directory.js";
import { controllerPlacement } from "../runners/placement.js";

type SessionCheckout = {
  agent: AgentRecord;
  manager: Pick<AgentManager, "inspectCheckout">;
};

/** Reads a repository's default-branch files on the runner a launch goes to. */
export type RepositoryFiles = (
  dirs: string[],
  wait: boolean
) => Promise<Res<"checkout.defaultFiles">>;

type FolderOrProject =
  | {
      kind: "folder";
      cwd: string;
      source: "catalog" | "workspace";
      runners: () => CheckoutCommandRunners;
    }
  | { kind: "project"; repoRoot: string; runners: () => CheckoutCommandRunners }
  | { kind: "builtins" };

export type PersonaScope =
  | ({ kind: "session" } & SessionCheckout)
  | FolderOrProject
  | {
      kind: "repository";
      read: RepositoryFiles;
      /** What this target read before the runner could (an older runner). */
      fallback: FolderOrProject;
    };

/** Chooses where a persona saved on a job or template is resolved. */
export type SavedPersonaScope = (target: {
  cwd: string;
  projectRoot?: string;
  /** The runner the saved target launches on. */
  placement?: Placement;
  /** Its project's repository, when it has one; asked only for another runner. */
  repository?: RepositoryOf;
}) => PersonaScope;

/** A target's project repository, read only when a launch elsewhere needs it. */
export type RepositoryOf =
  | string
  | null
  | (() => Promise<string | null | undefined>);

function folderOrProject(
  target: {
    cwd?: string;
    projectRoot?: string;
    source?: "catalog" | "workspace";
  },
  runners: () => CheckoutCommandRunners
): FolderOrProject {
  if (target.cwd)
    return {
      kind: "folder",
      cwd: target.cwd,
      source: target.source ?? "catalog",
      runners,
    };
  return target.projectRoot
    ? { kind: "project", repoRoot: target.projectRoot, runners }
    : { kind: "builtins" };
}

export function personaScopeFor(
  target:
    | SessionCheckout
    | {
        cwd?: string;
        projectRoot?: string;
        source?: "catalog" | "workspace";
        runners: () => CheckoutCommandRunners;
      }
): PersonaScope {
  if ("agent" in target) return { kind: "session", ...target };
  return folderOrProject(target, target.runners);
}

/**
 * Personas before a launch (D7). A folder is read only on the controller's
 * runner, as main reads it. A launch on any other runner reads its project's
 * repository there, from the runner's repository cache at the remote's
 * default branch, as main's catalog reads the origin's default branch.
 */
export function launchPersonaScope(
  manager: Pick<AgentManager, "checkoutReadRunners">,
  target: {
    placement: Placement;
    cwd?: string;
    projectRoot?: string;
    repository?: RepositoryOf;
    source?: "catalog" | "workspace";
  }
): PersonaScope {
  if (sameRunner(target.placement, controllerPlacement))
    return folderOrProject(target, () => manager.checkoutReadRunners());
  // Nothing on that runner names a folder; without a repository there is
  // nothing there to read before launch, as before.
  const fallback = folderOrProject({ projectRoot: target.projectRoot }, () =>
    manager.checkoutReadRunners()
  );
  const { repository: of } = target;
  if (!of) return fallback;
  const runner = runnerDirectory(manager.checkoutReadRunners()).for(
    target.placement
  );
  return {
    kind: "repository",
    async read(dirs, wait) {
      const repository = typeof of === "function" ? await of() : of;
      if (!repository)
        throw new RunnerCallError({
          code: "unsupported",
          message: "The project has no repository.",
        });
      return runner.call("checkout.defaultFiles", {
        target: { repository },
        dirs,
        wait,
      });
    },
    fallback,
  };
}

/** `launchPersonaScope` bound to a manager's runners. */
export type LaunchPersonaScope = (
  target: Parameters<typeof launchPersonaScope>[1]
) => PersonaScope;

/** The saved-target form of `launchPersonaScope` for jobs and templates. */
export function savedPersonaScope(
  manager: Pick<AgentManager, "checkoutReadRunners">
): SavedPersonaScope {
  return ({ cwd, projectRoot, placement, repository }) =>
    launchPersonaScope(manager, {
      placement: placement ?? controllerPlacement,
      cwd,
      projectRoot,
      repository,
    });
}

/** Main's independent checkout probe, used before a persona session exists. */
export async function personaCheckoutRoot(
  cwd: string,
  runners: CheckoutCommandRunners
): Promise<string | null> {
  const reply = await runnerDirectory(runners)
    .for(controllerPlacement)
    .call("git.roots", {
      target: { path: pathFromWire(path.resolve(cwd)) },
      checkoutOnly: true,
    });
  return reply.checkoutRoot ? displayPath(reply.checkoutRoot) : null;
}
