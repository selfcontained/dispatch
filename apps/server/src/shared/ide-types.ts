/**
 * IDE-type table and predicates.
 *
 * Single source of truth shared by the server (settings sanitization) and
 * the web client (IDE launch buttons, settings toggles) — web imports this
 * module directly across the workspace boundary (see
 * apps/web/src/lib/ide-types.ts). Keep it dependency-free: no node imports,
 * no browser globals.
 */

export const IDE_TYPES = ["vscode", "cursor"] as const;
export type IdeType = (typeof IDE_TYPES)[number];

export function isIdeType(value: unknown): value is IdeType {
  return typeof value === "string" && IDE_TYPES.includes(value as IdeType);
}

export function sanitizeEnabledIdes(value: unknown): IdeType[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isIdeType)
    .filter((type, index, types) => types.indexOf(type) === index);
}
