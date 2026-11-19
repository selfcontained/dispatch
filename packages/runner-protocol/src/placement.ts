export const MANAGED_WORKSPACE = "@session";

export type Placement = { runner: string; workspace: string };

/** Wire identities are case-sensitive and are not paths. */
export function isOpaqueId(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    /[\x00-\x1f\x7f-\x9f]/u.test(value)
  ) {
    return false;
  }
  try {
    // Reject lone UTF-16 surrogates, which have no UTF-8 representation.
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

/** Split first and decode each component exactly once. URL parsers can normalize IDs. */
export function remotePlacement(cwd: string): Placement | null {
  const match = /^runner:\/\/([\w.!~*'()%+-]+)\/([\w.!~*'()%+@-]+)$/.exec(cwd);
  if (!match || match[0] !== cwd) return null;
  try {
    const runner = decodeURIComponent(match[1]!);
    const workspace = decodeURIComponent(match[2]!);
    return isOpaqueId(runner) && isOpaqueId(workspace)
      ? { runner, workspace }
      : null;
  } catch {
    return null;
  }
}

export function workspaceLocator({ runner, workspace }: Placement): string {
  if (!isOpaqueId(runner) || !isOpaqueId(workspace)) {
    throw new Error("Invalid runner or workspace ID");
  }
  return `runner://${encodeURIComponent(runner)}/${workspace === MANAGED_WORKSPACE ? workspace : encodeURIComponent(workspace)}`;
}
