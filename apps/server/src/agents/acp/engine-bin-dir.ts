import path from "node:path";

/**
 * PATH with the engine CLI's own directory added last. An npm-installed CLI
 * is a `#!/usr/bin/env node` script, and when Dispatch found it outside PATH
 * (an nvm Node's bin, say, which a login shell without .zshrc never sees)
 * its `node` sits beside it and nowhere else. Last, so a `node` the person's
 * PATH already has still wins.
 */
export function withEngineBinDir(
  searchPath: string | undefined,
  bin: string | null | undefined
): string {
  const entries = (searchPath ?? "").split(path.delimiter).filter(Boolean);
  if (bin && path.isAbsolute(bin)) entries.push(path.dirname(bin));
  return Array.from(new Set(entries)).join(path.delimiter);
}
