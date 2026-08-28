import { useCallback, useMemo } from "react";
import { useAtom } from "jotai";

import {
  customTabHiddenAtomFamily,
  customTabOrderAtomFamily,
} from "@/lib/store";
import type { Surface } from "@/components/app/agent-surfaces/types";
import {
  mergeSurfaceTabOrder,
  moveEarlier,
  moveLater,
} from "@/components/app/agent-surfaces/surface-tab-order";

export type ManagedSurfaceTab = {
  surface: Surface;
  hidden: boolean;
};

/**
 * Layers the user's per-agent tab order/hidden prefs (localStorage) over the
 * server's canonical `sortOrder`. Never mutates the server document — this is
 * presentation-only state, colocated with the tab-strip feature that owns it.
 */
export function useSurfaceTabPrefs(
  agentId: string | null,
  surfaces: readonly Surface[]
) {
  const [storedOrder, setStoredOrder] = useAtom(
    customTabOrderAtomFamily(agentId ?? "")
  );
  const [hiddenIds, setHiddenIds] = useAtom(
    customTabHiddenAtomFamily(agentId ?? "")
  );

  const surfacesById = useMemo(
    () => new Map(surfaces.map((surface) => [surface.id, surface])),
    [surfaces]
  );

  const fullOrder = useMemo(
    () =>
      mergeSurfaceTabOrder(
        surfaces.map((surface) => surface.id),
        storedOrder
      ),
    [surfaces, storedOrder]
  );

  const hiddenSet = useMemo(() => new Set(hiddenIds), [hiddenIds]);

  const visibleOrder = useMemo(
    () => fullOrder.filter((id) => !hiddenSet.has(id)),
    [fullOrder, hiddenSet]
  );

  /** All non-hidden tabs, in display order — the direct tab strip scrolls
   * horizontally instead of collapsing extras into the overflow menu. */
  const visibleTabs = useMemo(
    () =>
      visibleOrder
        .map((id) => surfacesById.get(id))
        .filter(Boolean) as Surface[],
    [visibleOrder, surfacesById]
  );

  /** Every known tab in display order, for the manage menu. */
  const managedTabs = useMemo<ManagedSurfaceTab[]>(
    () =>
      fullOrder
        .map((id) => surfacesById.get(id))
        .filter((surface): surface is Surface => !!surface)
        .map((surface) => ({ surface, hidden: hiddenSet.has(surface.id) })),
    [fullOrder, surfacesById, hiddenSet]
  );

  const hiddenCount = hiddenSet.size;

  const moveTabEarlier = useCallback(
    (id: string) => setStoredOrder(moveEarlier(fullOrder, id)),
    [fullOrder, setStoredOrder]
  );

  const moveTabLater = useCallback(
    (id: string) => setStoredOrder(moveLater(fullOrder, id)),
    [fullOrder, setStoredOrder]
  );

  const toggleHidden = useCallback(
    (id: string) =>
      setHiddenIds((prev) =>
        prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      ),
    [setHiddenIds]
  );

  const resetOrder = useCallback(() => setStoredOrder([]), [setStoredOrder]);

  return {
    visibleTabs,
    managedTabs,
    hiddenCount,
    moveTabEarlier,
    moveTabLater,
    toggleHidden,
    resetOrder,
  };
}
