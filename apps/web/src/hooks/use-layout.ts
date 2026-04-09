import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtom } from "jotai";
import { leftSidebarOpenAtom, mediaSidebarOpenAtom } from "@/lib/store";

const MOBILE_BREAKPOINT_QUERY = "(max-width: 767px)";

export function useLayout() {
  const [leftOpen, setLeftOpen] = useAtom(leftSidebarOpenAtom);
  const [mediaOpen, setMediaOpen] = useAtom(mediaSidebarOpenAtom);
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches : false
  );
  const [mobileLeftOpen, setMobileLeftOpen] = useState(false);
  const [mobileMediaOpen, setMobileMediaOpen] = useState(false);

  const leftPanelOpen = isMobile ? mobileLeftOpen : leftOpen;
  const mediaPanelOpen = isMobile ? mobileMediaOpen : mediaOpen;

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
      setMobileMediaOpen(false);
    }
  }, [isMobile]);

  const handleSetLeftPanelOpen = useCallback(
    (open: boolean) => {
      if (isMobile) {
        if (open) setMobileMediaOpen(false);
        setMobileLeftOpen(open);
        return;
      }
      setLeftOpen(open);
    },
    [isMobile, setLeftOpen]
  );

  const handleSetMediaPanelOpen = useCallback(
    (open: boolean) => {
      if (isMobile) {
        if (open) setMobileLeftOpen(false);
        setMobileMediaOpen(open);
        return;
      }
      setMediaOpen(open);
    },
    [isMobile, setMediaOpen]
  );

  return useMemo(() => ({
    isMobile,
    leftOpen,
    mediaOpen,
    leftPanelOpen,
    mediaPanelOpen,
    mobileLeftOpen,
    mobileMediaOpen,
    setLeftOpen,
    setMediaOpen,
    setMobileLeftOpen,
    setMobileMediaOpen,
    handleSetLeftPanelOpen,
    handleSetMediaPanelOpen,
  }), [
    isMobile,
    leftOpen,
    mediaOpen,
    leftPanelOpen,
    mediaPanelOpen,
    mobileLeftOpen,
    mobileMediaOpen,
    setLeftOpen,
    setMediaOpen,
    handleSetLeftPanelOpen,
    handleSetMediaPanelOpen,
  ]);
}
