import { lstat, opendir, realpath } from "node:fs/promises";
import path from "node:path";

/** Recheck before enumeration and before publishing results. Dir does not expose
 * an fstat-capable descriptor, so never return names from a changed pathname. */
export async function openWorkspaceDirectory(root: string, target: string) {
  const relative = path.relative(root, target);
  if (
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  )
    throw Object.assign(new Error("Directory is outside the workspace."), {
      code: "ELOOP",
    });
  const initial = await lstat(target);
  if (initial.isSymbolicLink() || (await realpath(target)) !== target)
    throw Object.assign(new Error("Directory links are not followed."), {
      code: "ELOOP",
    });
  if (!initial.isDirectory())
    throw Object.assign(new Error("Not a directory."), { code: "ENOTDIR" });
  const verify = async () => {
    const current = await lstat(target);
    if (current.isSymbolicLink() || (await realpath(target)) !== target)
      throw Object.assign(new Error("Directory changed while opening."), {
        code: "ELOOP",
      });
    if (current.dev !== initial.dev || current.ino !== initial.ino)
      throw Object.assign(new Error("Directory changed while opening."), {
        code: "ESTALE",
      });
  };
  const directory = await opendir(target);
  try {
    await verify();
  } catch (error) {
    await directory.close();
    throw error;
  }
  return { directory, verify };
}
