import { useMemo } from "react";
import { useAtomValue } from "jotai";

import type { DiffFile, DiffResponse } from "@/hooks/use-agent-diff";
import { diffHideTestFilesAtom } from "@/lib/store";

/**
 * The single place that decides which files a diff shows, and in what order.
 *
 * The Changes tab renders this list and the header's +/− badge sums it, so the
 * count and the list are the same data by construction — a filter added or
 * changed here moves both at once instead of leaving one of them stale.
 *
 * What counts as a test is not decided here: the server sets `isTest` on each
 * file and applies the same predicate to build the excluding-tests totals the
 * sidebar badge reads. The client only honours the flag, so the list and the
 * badges cannot disagree about a file's classification.
 */
export function useVisibleDiffFiles(
  data: DiffResponse | undefined,
  preservePath: string | null = null
): DiffFile[] {
  const hideTestFiles = useAtomValue(diffHideTestFilesAtom);

  return useMemo(() => {
    const all = data?.files ?? [];
    const visible = hideTestFiles
      ? all.filter((file) => file.path === preservePath || !file.isTest)
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
