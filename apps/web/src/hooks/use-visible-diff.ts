import { useMemo } from "react";
import { useAtomValue } from "jotai";

import type { DiffFile, DiffResponse } from "@/hooks/use-agent-diff";
import { diffHideTestFilesAtom } from "@/lib/store";
import { excludeTestFiles } from "@/lib/test-files";

/**
 * The single place that decides which files a diff shows, and in what order.
 *
 * The Changes tab renders this list and the header's +/− badge sums it, so the
 * count and the list are the same data by construction — a filter added or
 * changed here moves both at once instead of leaving one of them stale.
 */
export function useVisibleDiffFiles(
  data: DiffResponse | undefined,
  preservePath: string | null = null
): DiffFile[] {
  const hideTestFiles = useAtomValue(diffHideTestFilesAtom);

  return useMemo(() => {
    const all = data?.files ?? [];
    const visible = hideTestFiles
      ? excludeTestFiles(all, preservePath)
      : [...all];
    return visible.sort((a, b) => a.path.localeCompare(b.path));
  }, [data?.files, hideTestFiles, preservePath]);
}

/**
 * Totals for a visible file list — the counterpart to `useVisibleDiffFiles`,
 * keyed to match `DiffStats` so callers can spread it over the server's totals.
 */
export function diffFileTotals(files: DiffFile[]): {
  added: number;
  deleted: number;
  files: number;
} {
  return {
    added: files.reduce((total, file) => total + file.added, 0),
    deleted: files.reduce((total, file) => total + file.deleted, 0),
    files: files.length,
  };
}
