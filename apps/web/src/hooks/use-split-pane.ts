import { useCallback, useMemo } from "react";
import { useAtom } from "jotai";

import {
  type CenterTab,
  type SplitPaneState,
  defaultSplitPaneState,
  splitPaneStateAtomFamily,
} from "@/lib/store";

const INACTIVE_ATOM = splitPaneStateAtomFamily("");

export function useSplitPane(agentId: string | null, isMobile: boolean) {
  const atom = agentId ? splitPaneStateAtomFamily(agentId) : INACTIVE_ATOM;
  const [rawState, setState] = useAtom(atom);

  const splitState: SplitPaneState =
    isMobile || !agentId ? defaultSplitPaneState : rawState;

  const isSplit = splitState.mode === "split" && !isMobile;

  const enterSplit = useCallback(
    (draggedTab: CenterTab, side: "left" | "right", activeTab: CenterTab) => {
      if (isMobile || !agentId) return;
      if (draggedTab === activeTab) return;

      const left = side === "left" ? draggedTab : activeTab;
      const right = side === "right" ? draggedTab : activeTab;

      setState({
        mode: "split",
        left,
        right,
        sizes: [50, 50],
      });
    },
    [agentId, isMobile, setState]
  );

  const exitSplit = useCallback(() => {
    setState((prev) => ({
      ...prev,
      mode: "single",
    }));
  }, [setState]);

  const updateSizes = useCallback(
    (sizes: number[]) => {
      if (sizes.length >= 2) {
        setState((prev) => ({
          ...prev,
          sizes: [sizes[0], sizes[1]] as [number, number],
        }));
      }
    },
    [setState]
  );

  const handleTabDrop = useCallback(
    (draggedTab: CenterTab, side: "left" | "right", activeTab: CenterTab) => {
      if (isMobile || !agentId) return;

      if (splitState.mode === "split") {
        setState((prev) => ({
          ...prev,
          [side]: draggedTab,
        }));
        return;
      }

      enterSplit(draggedTab, side, activeTab);
    },
    [agentId, enterSplit, isMobile, setState, splitState.mode]
  );

  return useMemo(
    () => ({
      splitState,
      isSplit,
      enterSplit,
      exitSplit,
      updateSizes,
      handleTabDrop,
    }),
    [splitState, isSplit, enterSplit, exitSplit, updateSizes, handleTabDrop]
  );
}
