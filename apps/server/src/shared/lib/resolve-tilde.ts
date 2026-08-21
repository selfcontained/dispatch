import os from "node:os";
import path from "node:path";

export function resolveTilde(value: string): string {
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  if (value === "~") return os.homedir();
  return value;
}

/**
 * Resolve a path that came from configuration — an env var or a stored
 * column — into an absolute path.
 *
 * Config values are not read by a shell, so a leading `~` arrives as a
 * literal character. Left alone it becomes a directory *named* `~` next to
 * the process's working directory, which fails silently: writes succeed,
 * and nothing can find them again. Every configured path goes through here
 * so `~` means the same thing everywhere it can be written.
 */
export function resolveConfiguredPath(value: string): string {
  return path.resolve(resolveTilde(value));
}
