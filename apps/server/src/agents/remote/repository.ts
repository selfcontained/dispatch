export {
  validBranch,
  repositoryUrl,
  projectRepositoryUrl,
  parseRepositoryTarget,
  parseRepository,
} from "@dispatch/runner-protocol";
export type {
  RepositoryInput,
  RepositoryTarget,
} from "@dispatch/runner-protocol";
import {
  runnerDirectory,
  type CheckoutCommandRunners,
} from "../../runners/directory.js";
import { controllerPlacement } from "../../runners/placement.js";

/** A folder's repository identity, read by the runner that owns the folder. */
export async function inferProjectRepository(
  cwd: string,
  runners: CheckoutCommandRunners = {}
): Promise<string | null> {
  try {
    return (
      await runnerDirectory(runners)
        .for(controllerPlacement)
        .call("git.origin", { path: cwd })
    ).url;
  } catch {
    return null;
  }
}
