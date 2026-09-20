import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtom } from "jotai";
import { leftSidebarOpenAtom } from "@/lib/store";

const MOBILE_BREAKPOINT_QUERY = "(max-width: 767px)";

export function useLayout() {
  const [leftOpen, setLeftOpen] = useAtom(leftSidebarOpenAtom);
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches
      : false
  );
  const [mobileLeftOpen, setMobileLeftOpen] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);

  const leftPanelOpen = isMobile ? mobileLeftOpen : leftOpen;

  // Media query listener for mobile breakpoint.
  useEffect(() => {
    const query = window.matchMedia(MOBILE_BREAKPOINT_QUERY);
    const onChange = () => setIsMobile(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // Reset mobile panels when switching to desktop.
  useEffect(() => {
    if (!isMobile) {
      setMobileLeftOpen(false);
      setMobileDrawerOpen(false);
    }
  }, [isMobile]);

  const handleSetLeftPanelOpen = useCallback(
    (open: boolean) => {
      if (isMobile) {
        if (open) setMobileDrawerOpen(false);
        setMobileLeftOpen(open);
        return;
      }
      setLeftOpen(open);
    },
    [isMobile, setLeftOpen]
  );

  return useMemo(
    () => ({
      isMobile,
      leftOpen,
      leftPanelOpen,
      mobileLeftOpen,
      mobileDrawerOpen,
      setLeftOpen,
      setMobileLeftOpen,
      setMobileDrawerOpen,
      handleSetLeftPanelOpen,
    }),
    [
      isMobile,
      leftOpen,
      leftPanelOpen,
      mobileLeftOpen,
      mobileDrawerOpen,
      setLeftOpen,
      handleSetLeftPanelOpen,
    ]
  );
}
