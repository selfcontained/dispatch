import { useCallback, useEffect, useMemo } from "react";
import { useAtom } from "jotai";

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
  const drawerOpen = isMobile ? mobileDrawerOpen : desktopDrawerState.isOpen;
  const drawerPanelOpen = drawerOpen;
  // A stored value from before the sidebar's tabs changed falls back to the Inbox.
  const drawerActiveTab = asDrawerTab(desktopDrawerState.activeTab);
  const drawerPinned = desktopDrawerState.isPinned ?? false;

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

  useEffect(() => {
    if (agentIds.length === 0) return;
    reconcileAgentScopedStorage(agentIds);
  }, [agentIds]);

  return {
    drawerOpen,
    drawerPanelOpen,
    drawerActiveTab,
    drawerPinned,
    setDrawerOpen,
    setDrawerActiveTab,
    toggleDrawerPinned,
  };
}
