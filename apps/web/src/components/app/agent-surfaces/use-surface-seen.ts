import { useCallback, useMemo } from "react";
import { useAtom } from "jotai";

import { seenSurfaceIdsAtomFamily } from "@/lib/store";

/**
 * Tracks which of this agent's surface tabs the user has already opened, so
 * a surface id the agent adds after the user's last visit can show a "new"
 * indicator until it's actually viewed. Persisted per agent (localStorage),
 * colocated with the tab-strip feature that owns it — mirrors
 * use-surface-tab-prefs.ts's atomFamily pattern.
 */
export function useSurfaceSeen(agentId: string | null) {
  const [seenIds, setSeenIds] = useAtom(
    seenSurfaceIdsAtomFamily(agentId ?? "")
  );
  const seenSet = useMemo(() => new Set(seenIds), [seenIds]);

  const isNew = useCallback(
    (surfaceId: string) => !seenSet.has(surfaceId),
    [seenSet]
  );

  const markSeen = useCallback(
    (surfaceId: string) => {
      setSeenIds((prev) =>
        prev.includes(surfaceId) ? prev : [...prev, surfaceId]
      );
    },
    [setSeenIds]
  );

  return { isNew, markSeen };
}
