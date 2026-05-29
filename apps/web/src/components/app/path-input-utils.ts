export type PathHistoryMetadata = {
  label?: string;
  usageCount?: number;
  iconUrl?: string;
};

export type HistoryOption = {
  path: string;
  label: string;
  usageCount: number;
  iconUrl?: string;
  originalIndex: number;
};

export function displayPathLabel(path: string): string {
  const normalized = path.replace(/\/$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return (parts.at(-1) ?? normalized) || path;
}

export function ghostCompletionSuffix(
  value: string,
  completion: string
): string {
  const base = value.replace(/\/$/, "");
  if (!completion.startsWith(base)) return "";
  let suffix = completion.slice(base.length);
  if (value.endsWith("/") && suffix.startsWith("/")) {
    suffix = suffix.slice(1);
  }
  return suffix;
}

export function acceptGhostCompletion(value: string, suffix: string): string {
  return value + suffix;
}

export function getHistoryOptions(
  history: string[],
  historyMetadata: Record<string, PathHistoryMetadata>
): HistoryOption[] {
  return history
    .map((path, originalIndex) => {
      const metadata = historyMetadata[path];
      return {
        path,
        label: metadata?.label ?? displayPathLabel(path),
        usageCount: metadata?.usageCount ?? 0,
        iconUrl: metadata?.iconUrl,
        originalIndex,
      };
    })
    .sort((left, right) => {
      if (right.usageCount !== left.usageCount) {
        return right.usageCount - left.usageCount;
      }
      return left.originalIndex - right.originalIndex;
    });
}

export function filterHistoryOptions(
  options: HistoryOption[],
  query: string
): HistoryOption[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return options;

  return options.filter((option) => {
    const label = option.label.toLowerCase();
    const path = option.path.toLowerCase();
    const pathSegments = path.split("/").filter(Boolean);

    return (
      label.includes(trimmed) ||
      path.includes(trimmed) ||
      pathSegments.some((segment) => segment.includes(trimmed))
    );
  });
}
