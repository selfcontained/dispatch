import path from "node:path";

const PROTECTED_HOME_RELATIVE_DIRS = [
  "Desktop",
  "Documents",
  "Downloads",
  "Movies",
  "Music",
  "Pictures",
  path.join("Library", "CloudStorage"),
  path.join("Library", "Mobile Documents"),
] as const;

/**
 * Pure string-prefix check against macOS TCC-protected user folders.
 * Intentionally does NOT call `realpath()` or any other filesystem syscall.
 *
 * Why no realpath: TCC routes accesses to `~/Library/Mobile Documents`
 * (iCloud Drive) and `~/Library/CloudStorage` (third-party cloud sync)
 * through the indirect FileProvider TCC code path. For a launchd-spawned
 * daemon with an ad-hoc-signed binary (which Bun's `--compile` produces),
 * an unanswered indirect TCC request hangs indefinitely instead of failing
 * with EPERM. Calling `realpath()` on those paths to canonicalize them —
 * what an earlier version of this file did — is enough on its own to wedge
 * every path-info request on the dispatch server until the TCC prompt is
 * answered (which never happens for a daemon with no foreground UI).
 *
 * The trade-off: we no longer follow symlinks. If a user types a path that
 * symlinks INTO a protected dir, this check returns false. That's
 * acceptable — the caller's downstream `stat()` will still hit TCC against
 * the underlying protected dir, get EPERM in bounded time (this is the
 * direct TCC path, not the indirect FileProvider one), and the request
 * completes with `exists=false` rather than wedging.
 */

function normalize(value: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(value);
  return platform === "darwin" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function isSameOrChildPath(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

export function isMacProtectedPath(
  candidatePath: string,
  homeDir: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const normalizedCandidate = normalize(candidatePath, platform);
  for (const segment of PROTECTED_HOME_RELATIVE_DIRS) {
    const protectedRoot = normalize(path.join(homeDir, segment), platform);
    if (isSameOrChildPath(normalizedCandidate, protectedRoot)) {
      return true;
    }
  }
  return false;
}

export function shouldSkipAutomaticMacPathProbe(
  candidatePath: string,
  homeDir: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return (
    platform === "darwin" &&
    isMacProtectedPath(candidatePath, homeDir, platform)
  );
}
