import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

export type SystemDefaults = {
  /** Server's home directory — used to seed the default agent cwd. */
  homeDir: string;
  /**
   * Whether the host can place a browser-pasted image on a clipboard the agent
   * CLI can read (macOS pasteboard, or Linux + Xvfb). Drives the choice between
   * native Ctrl+V paste and a path-based media upload.
   */
  clipboardImagePaste: boolean;
};

/**
 * Shared accessor for GET /api/v1/system/defaults. These values are fixed for
 * the lifetime of the server process, so the query never goes stale — React
 * Query dedupes/caches the single request across every consumer.
 */
export function useSystemDefaults() {
  return useQuery<SystemDefaults>({
    queryKey: ["system", "defaults"],
    queryFn: () => api<SystemDefaults>("/api/v1/system/defaults"),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
