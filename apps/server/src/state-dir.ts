import os from "node:os";
import path from "node:path";

import { resolveConfiguredPath } from "./shared/lib/resolve-tilde.js";

/**
 * Where one install keeps its state: release and update stores, diagnostics,
 * logs, and the defaults for files and agent host state. `~/.dispatch` for
 * the machine's install; `DISPATCH_STATE_DIR` points a second instance (a
 * new version being tried next to the old one) at a directory of its own,
 * so the two never read each other's files. Each file's own `DISPATCH_*_PATH`
 * variable still overrides its location individually.
 */
export function stateDir(): string {
  return resolveConfiguredPath(
    process.env.DISPATCH_STATE_DIR ?? path.join(os.homedir(), ".dispatch")
  );
}

export function statePath(...segments: string[]): string {
  return path.join(stateDir(), ...segments);
}
