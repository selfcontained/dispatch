import path from "node:path";
import {
  displayPath,
  type Req,
  type Res,
} from "@dispatch/runner-protocol/contract";
import { AgentError } from "../agents/errors.js";

// Main also trims a trailing backslash on POSIX.
function normalizedDirectory(value: string) {
  const resolved = path.resolve(value);
  return resolved.replace(/[\\/]+$/, "") || resolved;
}

/** Project the in-process path probe into main's workspace selection result. */
export async function selectWorkspaceFromResolution(
  home: string,
  requested: string,
  resolvePath: (
    raw: string,
    options: Omit<Req<"path.resolve">, "path">
  ) => Promise<Res<"path.resolve">>
) {
  const found = await resolvePath(requested, { canonical: [home] }).catch(
    () => null
  );
  if (!found?.exists) throw new AgentError(requested + " does not exist.", 400);
  if (!found.isDirectory)
    throw new AgentError(requested + " is not a directory.", 400);
  const canonical = found.canonicalPath
    ? displayPath(found.canonicalPath)
    : requested;
  const directory = normalizedDirectory(canonical);
  // A literal final backslash in a POSIX name changes the directory main probes.
  const facts =
    directory === canonical ? found : await resolvePath(directory, {});
  if (facts.gitFailed)
    throw new AgentError("Could not read git state in " + directory + ".", 400);
  const workspace = facts.git ? displayPath(facts.git.worktreePath) : directory;
  const canonicalHome = found.canonical?.[0];
  return {
    path: workspace,
    moved:
      workspace !==
      normalizedDirectory(canonicalHome ? displayPath(canonicalHome) : home),
    repoRoot: facts.git ? displayPath(facts.git.repoRoot) : null,
  };
}
