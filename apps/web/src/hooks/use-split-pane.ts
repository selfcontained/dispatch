import { useCallback, useMemo } from "react";
import { useAtom } from "jotai";

import { type LegacyCenterTab } from "@/lib/center-tabs";
import {
  type CenterTab,
  type PersistedSplitPaneState,
  type SplitPaneState,
  defaultSplitPaneState,
  inactiveSplitPaneStateAtom,
  isCurrentSplitPaneState,
  splitPaneStateAtomFamily,
} from "@/lib/store";

/**
 * Older builds persisted a "chat" pane and a "terminal" pane; both read as
 * the Agent pane now. A split that collapses to the same pane twice (Chat
 * beside the old Terminal, say) is shown as a single pane.
 */
export function normalizeSplitPaneState(
  state: PersistedSplitPaneState
): SplitPaneState {
  const fold = (tab: LegacyCenterTab): CenterTab =>
    tab === "chat" || tab === "terminal" ? "agent" : tab;
  const left = fold(state.left);
  const right = fold(state.right);
  if (
    left === state.left &&
    right === state.right &&
    isCurrentSplitPaneState(state)
  ) {
    return state;
  }
  return {
    ...state,
    left,
    right,
    mode: left === right ? "single" : state.mode,
  };
}

export function useSplitPane(agentId: string | null, isMobile: boolean) {
  const atom = agentId
    ? splitPaneStateAtomFamily(agentId)
    : inactiveSplitPaneStateAtom;
  const [rawState, setState] = useAtom(atom);

  const splitState: SplitPaneState = useMemo(
    () =>
      isMobile || !agentId
        ? defaultSplitPaneState
        : normalizeSplitPaneState(rawState),
    [agentId, isMobile, rawState]
  );

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
    if (isMobile || !agentId) return;
    setState((prev) => ({
      ...prev,
      mode: "single",
    }));
  }, [agentId, isMobile, setState]);

  const updateSizes = useCallback(
    (sizes: number[]) => {
      if (isMobile || !agentId) return;
      if (sizes.length >= 2) {
        setState((prev) => ({
          ...prev,
          sizes: [sizes[0], sizes[1]] as [number, number],
        }));
      }
    },
    [agentId, isMobile, setState]
  );

  const handleTabDrop = useCallback(
    (draggedTab: CenterTab, side: "left" | "right", activeTab: CenterTab) => {
      if (isMobile || !agentId) return;

      if (splitState.mode === "split") {
        const otherSide = side === "left" ? "right" : "left";
        if (splitState[otherSide] === draggedTab) return;
        setState((prev) => ({
          ...prev,
          [side]: draggedTab,
        }));
        return;
      }

      enterSplit(draggedTab, side, activeTab);
    },
    [agentId, enterSplit, isMobile, setState, splitState]
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
