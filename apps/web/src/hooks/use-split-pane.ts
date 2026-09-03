import { useCallback, useMemo } from "react";
import { useAtom } from "jotai";

import { useChatSurfaceEnabled } from "@/hooks/use-chat-surface-enabled";
import { type LegacyCenterTab, terminalHostTab } from "@/lib/center-tabs";
import {
  type CenterTab,
  type SplitPaneState,
  defaultSplitPaneState,
  inactiveSplitPaneStateAtom,
  splitPaneStateAtomFamily,
} from "@/lib/store";

/**
 * The terminal-hosting tab goes by "agent" with the chat surface on and
 * "terminal" with it off, and round 1/2 persisted a separate "chat" pane. A
 * stored value from any of those reads as whichever id is current, so a
 * split saved under one flag value still renders under the other. A split
 * that collapses to the same pane twice (Chat beside Console, say) is shown
 * as a single pane. The stored value is left alone so nothing is lost if
 * the flag flips back.
 */
export function normalizeSplitPaneState(
  state: SplitPaneState,
  chatEnabled: boolean
): SplitPaneState {
  const host = terminalHostTab(chatEnabled);
  const fold = (tab: LegacyCenterTab): CenterTab =>
    tab === "chat" || tab === "agent" || tab === "terminal" ? host : tab;
  const left = fold(state.left);
  const right = fold(state.right);
  if (left === state.left && right === state.right) return state;
  return {
    ...state,
    left,
    right,
    mode: left === right ? "single" : state.mode,
  };
}

export function useSplitPane(agentId: string | null, isMobile: boolean) {
  const { enabled: chatEnabled } = useChatSurfaceEnabled();
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
