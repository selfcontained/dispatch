/** Native fixture adapter only. Production callers supply runner or CLI-owned ports. */
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  hasCodeowners as hasFiles,
  loadCodeownersFromFiles,
  type CodeownersFiles,
} from "../../src/personas/codeowners.js";
export * from "../../src/personas/codeowners.js";
function nativeFiles(root: string): CodeownersFiles {
  return {
    async access(file) {
      try {
        await access(path.join(root, file));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return false;
      }
    },
    read: (file) => readFile(path.join(root, file), "utf8"),
  };
}
export function loadCodeowners(root: string) {
  return loadCodeownersFromFiles(nativeFiles(root));
}
export function hasCodeowners(root: string) {
  return hasFiles(nativeFiles(root));
}
