import { useCallback, useEffect, useMemo, useState } from "react";

const LEFT_SIDEBAR_KEY = "dispatch:leftSidebarOpen";
const MEDIA_SIDEBAR_KEY = "dispatch:mediaSidebarOpen";
const MOBILE_BREAKPOINT_QUERY = "(max-width: 767px)";

function readBool(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  const stored = window.localStorage.getItem(key);
  return stored === null ? fallback : stored === "true";
}

export function useLayout() {
  const [leftOpen, setLeftOpen] = useState(() => readBool(LEFT_SIDEBAR_KEY, true));
  const [mediaOpen, setMediaOpen] = useState(() => readBool(MEDIA_SIDEBAR_KEY, false));
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

  // Persist sidebar state to localStorage.
  useEffect(() => {
    const value = String(leftOpen);
    window.localStorage.setItem(LEFT_SIDEBAR_KEY, value);
  }, [leftOpen]);

  useEffect(() => {
    const value = String(mediaOpen);
    window.localStorage.setItem(MEDIA_SIDEBAR_KEY, value);
  }, [mediaOpen]);

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
    [isMobile]
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
    [isMobile]
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
    handleSetLeftPanelOpen,
    handleSetMediaPanelOpen,
  ]);
}
