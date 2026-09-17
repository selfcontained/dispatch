import { useCallback, useEffect, useRef, useState } from "react";

import { TAB_DRAG_MIME } from "@/components/app/center-pane-tab-bar";
import { type CenterTab } from "@/lib/center-tabs";
import { useSplitPane } from "@/hooks/use-split-pane";

type UseCenterPaneLayoutArgs = {
  focusedAgentId: string | null;
  isMobile: boolean;
  /** The tab currently shown full-width; the drop target for a dragged tab. */
  activeTab: CenterTab;
};

/**
 * Owns the center-pane split layout mechanics: the split-pane state and the
 * tab drag-and-drop plumbing.
 */
export function useCenterPaneLayout({
  focusedAgentId,
  isMobile,
  activeTab,
}: UseCenterPaneLayoutArgs) {
  const [isDraggingTab, setIsDraggingTab] = useState(false);

  const { splitState, isSplit, exitSplit, updateSizes, handleTabDrop } =
    useSplitPane(focusedAgentId, isMobile);

  const splitLeftRef = useRef<HTMLDivElement>(null);
  const splitButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isSplit) return;
    const panel = splitLeftRef.current;
    const btn = splitButtonRef.current;
    if (!panel || !btn) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width != null) btn.style.left = `${width}px`;
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [isSplit]);

  useEffect(() => {
    const reset = () => setIsDraggingTab(false);
    document.addEventListener("dragend", reset);
    return () => document.removeEventListener("dragend", reset);
  }, []);

  const handleContentDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(TAB_DRAG_MIME)) return;
    setIsDraggingTab(true);
  }, []);

  const handleContentDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDraggingTab(false);
  }, []);

  const handleContentDrop = useCallback(() => {
    setIsDraggingTab(false);
  }, []);

  const handleDropOnZone = useCallback(
    (tab: string, side: "left" | "right") => {
      handleTabDrop(tab as CenterTab, side, activeTab);
      setIsDraggingTab(false);
    },
    [activeTab, handleTabDrop]
  );

  const handleSplitLayoutChange = useCallback(
    (layout: Record<string, number>) => {
      const left = layout["split-left"];
      const right = layout["split-right"];
      if (typeof left !== "number" || typeof right !== "number") return;
      updateSizes([left, right]);
    },
    [updateSizes]
  );

  return {
    splitState,
    isSplit,
    exitSplit,
    isDraggingTab,
    splitLeftRef,
    splitButtonRef,
    handleContentDragOver,
    handleContentDragLeave,
    handleContentDrop,
    handleDropOnZone,
    handleSplitLayoutChange,
  };
}
