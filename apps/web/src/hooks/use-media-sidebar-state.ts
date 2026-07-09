import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtom } from "jotai";

import { MEDIA_SIDEBAR_SETTLE_FALLBACK_MS } from "@/components/app/media-sidebar-constants";
import {
  inactiveMediaSidebarStateAtom,
  mediaSidebarStateAtomFamily,
  reconcileMediaSidebarStateStorage,
  reconcileDiffViewStateStorage,
  reconcileSplitPaneStateStorage,
  reconcileReviewDraftStorage,
  type MediaSidebarTab,
} from "@/lib/store";

type UseMediaSidebarStateOptions = {
  sidebarAgentId: string | null;
  isMobile: boolean;
  agentIds: readonly string[];
  mobileMediaOpen: boolean;
  setMobileLeftOpen: (open: boolean) => void;
  setMobileMediaOpen: (open: boolean) => void;
};

export function useMediaSidebarState({
  sidebarAgentId,
  isMobile,
  agentIds,
  mobileMediaOpen,
  setMobileLeftOpen,
  setMobileMediaOpen,
}: UseMediaSidebarStateOptions) {
  const desktopMediaSidebarAtom = useMemo(
    () =>
      sidebarAgentId
        ? mediaSidebarStateAtomFamily(sidebarAgentId)
        : inactiveMediaSidebarStateAtom,
    [sidebarAgentId]
  );
  const [desktopMediaSidebarState, setDesktopMediaSidebarState] = useAtom(
    desktopMediaSidebarAtom
  );
  const [deferMediaResize, setDeferMediaResize] = useState(false);
  const [mediaResizeSettleKey, setMediaResizeSettleKey] = useState(0);
  const mediaOpen = isMobile
    ? mobileMediaOpen
    : desktopMediaSidebarState.isOpen;
  const mediaPanelOpen = mediaOpen;
  const mediaActiveTab = desktopMediaSidebarState.activeTab;
  const mediaPinned = desktopMediaSidebarState.isPinned ?? false;
  const mediaShiftsLayout = !isMobile && mediaOpen && mediaPinned;
  const mediaResizeTimerRef = useRef<number | null>(null);

  const setMediaActiveTab = useCallback(
    (activeTab: MediaSidebarTab) => {
      setDesktopMediaSidebarState((prev) => ({ ...prev, activeTab }));
    },
    [setDesktopMediaSidebarState]
  );

  const setMediaOpen = useCallback(
    (open: boolean) => {
      if (isMobile) {
        if (open) setMobileLeftOpen(false);
        setMobileMediaOpen(open);
        return;
      }

      setDesktopMediaSidebarState((prev) =>
        prev.isOpen === open ? prev : { ...prev, isOpen: open }
      );
    },
    [
      isMobile,
      setDesktopMediaSidebarState,
      setMobileLeftOpen,
      setMobileMediaOpen,
    ]
  );

  const toggleMediaPinned = useCallback(() => {
    setDesktopMediaSidebarState((prev) => ({
      ...prev,
      isPinned: !(prev.isPinned ?? false),
    }));
  }, [setDesktopMediaSidebarState]);

  const finishMediaResizeSettle = useCallback(() => {
    if (mediaResizeTimerRef.current) {
      window.clearTimeout(mediaResizeTimerRef.current);
      mediaResizeTimerRef.current = null;
    }
    setDeferMediaResize(false);
    setMediaResizeSettleKey((current) => current + 1);
  }, []);

  const prevMediaShiftsLayoutRef = useRef(mediaShiftsLayout);
  useEffect(() => {
    if (agentIds.length === 0) return;
    reconcileMediaSidebarStateStorage(agentIds as string[]);
    reconcileDiffViewStateStorage(agentIds as string[]);
    reconcileSplitPaneStateStorage(agentIds as string[]);
    reconcileReviewDraftStorage(agentIds as string[]);
  }, [agentIds]);

  useEffect(() => {
    if (isMobile) {
      prevMediaShiftsLayoutRef.current = mediaShiftsLayout;
      return;
    }
    if (prevMediaShiftsLayoutRef.current === mediaShiftsLayout) return;
    prevMediaShiftsLayoutRef.current = mediaShiftsLayout;
    setDeferMediaResize(true);
    if (mediaResizeTimerRef.current) {
      window.clearTimeout(mediaResizeTimerRef.current);
    }
    mediaResizeTimerRef.current = window.setTimeout(
      finishMediaResizeSettle,
      MEDIA_SIDEBAR_SETTLE_FALLBACK_MS
    );
  }, [finishMediaResizeSettle, isMobile, mediaShiftsLayout]);

  useEffect(
    () => () => {
      if (mediaResizeTimerRef.current) {
        window.clearTimeout(mediaResizeTimerRef.current);
      }
    },
    []
  );

  return {
    mediaOpen,
    mediaPanelOpen,
    mediaActiveTab,
    mediaPinned,
    deferMediaResize,
    mediaResizeSettleKey,
    setMediaOpen,
    setMediaActiveTab,
    toggleMediaPinned,
    finishMediaResizeSettle,
  };
}
