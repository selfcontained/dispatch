import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtom } from "jotai";

import { DRAWER_SETTLE_FALLBACK_MS } from "@/components/app/drawer-constants";
import {
  asDrawerTab,
  inactiveDrawerStateAtom,
  drawerStateAtomFamily,
  reconcileAgentScopedStorage,
  type DrawerTab,
} from "@/lib/store";

type UseDrawerStateOptions = {
  sidebarAgentId: string | null;
  isMobile: boolean;
  agentIds: readonly string[];
  mobileDrawerOpen: boolean;
  setMobileLeftOpen: (open: boolean) => void;
  setMobileDrawerOpen: (open: boolean) => void;
};

export function useDrawerState({
  sidebarAgentId,
  isMobile,
  agentIds,
  mobileDrawerOpen,
  setMobileLeftOpen,
  setMobileDrawerOpen,
}: UseDrawerStateOptions) {
  const desktopDrawerAtom = useMemo(
    () =>
      sidebarAgentId
        ? drawerStateAtomFamily(sidebarAgentId)
        : inactiveDrawerStateAtom,
    [sidebarAgentId]
  );
  const [desktopDrawerState, setDesktopDrawerState] =
    useAtom(desktopDrawerAtom);
  const [deferDrawerResize, setDeferDrawerResize] = useState(false);
  const [drawerResizeSettleKey, setDrawerResizeSettleKey] = useState(0);
  const drawerOpen = isMobile ? mobileDrawerOpen : desktopDrawerState.isOpen;
  const drawerPanelOpen = drawerOpen;
  // A stored value from before the sidebar's tabs changed falls back to the Inbox.
  const drawerActiveTab = asDrawerTab(desktopDrawerState.activeTab);
  const drawerPinned = desktopDrawerState.isPinned ?? false;
  const drawerShiftsLayout = !isMobile && drawerOpen && drawerPinned;
  const drawerResizeTimerRef = useRef<number | null>(null);

  const setDrawerActiveTab = useCallback(
    (activeTab: DrawerTab) => {
      setDesktopDrawerState((prev) => ({ ...prev, activeTab }));
    },
    [setDesktopDrawerState]
  );

  const setDrawerOpen = useCallback(
    (open: boolean) => {
      if (isMobile) {
        if (open) setMobileLeftOpen(false);
        setMobileDrawerOpen(open);
        return;
      }

      setDesktopDrawerState((prev) =>
        prev.isOpen === open ? prev : { ...prev, isOpen: open }
      );
    },
    [isMobile, setDesktopDrawerState, setMobileLeftOpen, setMobileDrawerOpen]
  );

  const toggleDrawerPinned = useCallback(() => {
    setDesktopDrawerState((prev) => ({
      ...prev,
      isPinned: !(prev.isPinned ?? false),
    }));
  }, [setDesktopDrawerState]);

  const finishDrawerResizeSettle = useCallback(() => {
    if (drawerResizeTimerRef.current) {
      window.clearTimeout(drawerResizeTimerRef.current);
      drawerResizeTimerRef.current = null;
    }
    setDeferDrawerResize(false);
    setDrawerResizeSettleKey((current) => current + 1);
  }, []);

  const prevDrawerShiftsLayoutRef = useRef(drawerShiftsLayout);
  useEffect(() => {
    if (agentIds.length === 0) return;
    reconcileAgentScopedStorage(agentIds);
  }, [agentIds]);

  useEffect(() => {
    if (isMobile) {
      prevDrawerShiftsLayoutRef.current = drawerShiftsLayout;
      return;
    }
    if (prevDrawerShiftsLayoutRef.current === drawerShiftsLayout) return;
    prevDrawerShiftsLayoutRef.current = drawerShiftsLayout;
    setDeferDrawerResize(true);
    if (drawerResizeTimerRef.current) {
      window.clearTimeout(drawerResizeTimerRef.current);
    }
    drawerResizeTimerRef.current = window.setTimeout(
      finishDrawerResizeSettle,
      DRAWER_SETTLE_FALLBACK_MS
    );
  }, [finishDrawerResizeSettle, isMobile, drawerShiftsLayout]);

  useEffect(
    () => () => {
      if (drawerResizeTimerRef.current) {
        window.clearTimeout(drawerResizeTimerRef.current);
      }
    },
    []
  );

  return {
    drawerOpen,
    drawerPanelOpen,
    drawerActiveTab,
    drawerPinned,
    deferDrawerResize,
    drawerResizeSettleKey,
    setDrawerOpen,
    setDrawerActiveTab,
    toggleDrawerPinned,
    finishDrawerResizeSettle,
  };
}
