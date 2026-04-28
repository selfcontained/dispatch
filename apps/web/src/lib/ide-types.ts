export const IDE_TYPES = ["vscode", "cursor"] as const;
export type IdeType = (typeof IDE_TYPES)[number];

export const IDE_LABELS: Record<IdeType, string> = {
  vscode: "VS Code",
  cursor: "Cursor",
};

export function isIdeType(value: unknown): value is IdeType {
  return typeof value === "string" && IDE_TYPES.includes(value as IdeType);
}

export function sanitizeEnabledIdes(value: unknown): IdeType[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isIdeType)
    .filter((type, index, types) => types.indexOf(type) === index);
}
