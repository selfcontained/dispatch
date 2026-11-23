import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { detectIconFrom, type IconSource } from "./icon-scan.js";

/** The host filesystem's view of a directory. */
function directorySource(dir: string): IconSource {
  return {
    async isFile(rel) {
      try {
        return (await stat(path.join(dir, rel))).isFile();
      } catch {
        return false;
      }
    },
    async list(rel) {
      try {
        return (
          await readdir(path.join(dir, rel), { withFileTypes: true })
        ).map((entry) => ({
          name: entry.name,
          kind: entry.isSymbolicLink()
            ? "link"
            : entry.isFile()
              ? "file"
              : entry.isDirectory()
                ? "directory"
                : "other",
        }));
      } catch {
        return null;
      }
    },
  };
}

export function detectRepoIcon(dir: string): Promise<string | null> {
  return detectIconFrom(directorySource(dir));
}
