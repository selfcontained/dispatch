import { useCallback, useMemo } from "react";
import { useAtom } from "jotai";

import {
  type CenterTab,
  type SplitPaneState,
  defaultSplitPaneState,
  inactiveSplitPaneStateAtom,
  splitPaneStateAtomFamily,
} from "@/lib/store";

/**
 * With the chat surface off, a persisted "chat" pane has nothing to render:
 * it falls back to the terminal, and a split that collapses to two terminals
 * is shown as a single pane. The stored value is left alone so it comes back
 * when the flag is turned on again.
 */
export function normalizeSplitPaneState(
  state: SplitPaneState,
  chatEnabled: boolean
): SplitPaneState {
  if (chatEnabled) return state;
  if (state.left !== "chat" && state.right !== "chat") return state;
  const left: CenterTab = state.left === "chat" ? "terminal" : state.left;
  const right: CenterTab = state.right === "chat" ? "terminal" : state.right;
  return {
    ...state,
    left,
    right,
    mode: left === right ? "single" : state.mode,
  };
}

export function useSplitPane(
  agentId: string | null,
  isMobile: boolean,
  chatEnabled = false
) {
  const atom = agentId
    ? splitPaneStateAtomFamily(agentId)
    : inactiveSplitPaneStateAtom;
  const [rawState, setState] = useAtom(atom);

  const splitState: SplitPaneState = useMemo(
    () =>
      isMobile || !agentId
        ? defaultSplitPaneState
        : normalizeSplitPaneState(rawState, chatEnabled),
    [agentId, chatEnabled, isMobile, rawState]
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
