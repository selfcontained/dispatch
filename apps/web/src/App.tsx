import { useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useMatches, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import "@xterm/xterm/css/xterm.css";

import { type NavSection } from "@/components/app/sidebar-shell";
import { type Agent } from "@/components/app/types";
import { type DashboardContextValue } from "@/components/app/dashboard-context";
import { initEnergyMetrics } from "@/lib/energy-metrics";
import { api } from "@/lib/api";
import { useAuthContext } from "@/contexts/auth-context";
import { useHealth } from "@/hooks/use-health";
import { useLayout } from "@/hooks/use-layout";
import { useSSE } from "@/hooks/use-sse";
import { useAgentSoundCues } from "@/hooks/use-agent-sound-cues";
import { useIconColor } from "@/hooks/use-icon-color";
import { useInstanceName } from "@/hooks/use-instance-name";
import { useTheme } from "@/hooks/use-theme";
import { useTemporaryState } from "@/hooks/use-temporary-state";
import {
  AGENT_TYPES,
  type AgentType,
  sanitizeEnabledAgentTypes,
} from "@/lib/agent-types";
import { type IdeType, sanitizeEnabledIdes } from "@/lib/ide-types";
import { sortAgentsByCreatedAtDesc } from "@/lib/agent-sort";
import { TipQueueProvider } from "@/components/tips/tip-queue-provider";
import { TipsVersionInit } from "@/components/tips/tips-version-init";
import { ReleaseAvailableToast } from "@/components/app/release-available-toast";
import { UpdateAvailableToast } from "@/components/app/update-available-toast";
import { Toaster } from "sonner";

type RouteHandle = {
  navSection?: NavSection;
};

export function DashboardLayout(): JSX.Element {
  const navigate = useNavigate();
  const matches = useMatches() as Array<{ handle?: RouteHandle }>;

  const currentNavItem =
    [...matches]
      .reverse()
      .map((match) => match.handle?.navSection)
      .find(Boolean) ?? null;

  const { theme, setTheme } = useTheme();
  const {
    iconColor,
    setIconColor,
    isLoading: isIconColorSaving,
    error: iconColorError,
    clearError: clearIconColorError,
  } = useIconColor();
  const { instanceName } = useInstanceName();
  const { handleLogout } = useAuthContext();
  const {
    isMobile,
    leftOpen,
    leftPanelOpen,
    mobileLeftOpen,
    mobileMediaOpen,
    setLeftOpen,
    setMobileLeftOpen,
    setMobileMediaOpen,
    handleSetLeftPanelOpen,
  } = useLayout();
  const { apiState, dbState } = useHealth(true);

  const [enabledAgentTypes, setEnabledAgentTypes] = useState<AgentType[]>([
    ...AGENT_TYPES,
  ]);
  const [enabledIdes, setEnabledIdes] = useState<IdeType[]>([]);
  const { data: agents = [] } = useQuery<Agent[]>({
    queryKey: ["agents"],
    queryFn: async () => {
      const payload = await api<{ agents: Agent[] }>("/api/v1/agents");
      return payload.agents;
    },
    select: (data) => sortAgentsByCreatedAtDesc(data),
  });

  useEffect(() => {
    document.title = instanceName ? `${instanceName} — Dispatch` : "Dispatch";
  }, [instanceName]);

  useEffect(() => initEnergyMetrics(), []);

  // SSE + sound cues live at the dashboard root so events flow on every
  // route, not just /agents. The hooks only write to the React Query cache,
  // so they don't depend on any view-local state.
  useSSE("authenticated");
  useAgentSoundCues();

  useEffect(() => {
    let cancelled = false;

    void api<{ enabledAgentTypes: AgentType[] }>(
      "/api/v1/app/settings/agent-types"
    )
      .then((payload) => {
        if (cancelled) return;
        setEnabledAgentTypes(
          sanitizeEnabledAgentTypes(payload.enabledAgentTypes)
        );
      })
      .catch(() => {
        if (cancelled) return;
      });

    void api<{ enabledIdes: IdeType[] }>("/api/v1/app/settings/ides")
      .then((payload) => {
        if (cancelled) return;
        setEnabledIdes(sanitizeEnabledIdes(payload.enabledIdes));
      })
      .catch(() => {
        if (cancelled) return;
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const [pulsingNavItem, setPulsingNavItem] = useTemporaryState<string | null>(
    null,
    260
  );
  const [pendingNavPulse, setPendingNavPulse] = useState<string | null>(null);
  const prevNavItemRef = useRef(currentNavItem);

  useEffect(() => {
    const previousNavItem = prevNavItemRef.current;
    prevNavItemRef.current = currentNavItem;

    if (!isMobile) return;
    if (!previousNavItem || !currentNavItem) return;
    if (currentNavItem === previousNavItem) return;

    setMobileMediaOpen(false);
    if (currentNavItem !== "activity") {
      setMobileLeftOpen(true);
    }
  }, [currentNavItem, isMobile, setMobileLeftOpen, setMobileMediaOpen]);

  useEffect(() => {
    if (!pendingNavPulse || pendingNavPulse !== currentNavItem) return;
    setPulsingNavItem(pendingNavPulse);
    setPendingNavPulse(null);
  }, [currentNavItem, pendingNavPulse, setPulsingNavItem]);

  const triggerNavAnimation = useCallback(
    (navItem: string) => {
      if (navItem === currentNavItem) {
        setPulsingNavItem(navItem);
        return;
      }
      setPendingNavPulse(navItem);
    },
    [currentNavItem, setPulsingNavItem]
  );

  const handleSidebarNavigate = useCallback(
    (section: NavSection) => {
      if (section === "agents") navigate("/agents");
      else if (section === "automations") navigate("/automations");
      else if (section === "activity") navigate("/activity/metrics");
      else if (section === "settings") navigate("/settings");
    },
    [navigate]
  );

  const context: DashboardContextValue = {
    agents,
    enabledAgentTypes,
    setEnabledAgentTypes,
    enabledIdes,
    setEnabledIdes,
    handleLogout,
    isMobile,
    leftOpen,
    leftPanelOpen,
    mobileLeftOpen,
    mobileMediaOpen,
    setLeftOpen,
    setMobileLeftOpen,
    setMobileMediaOpen,
    handleSetLeftPanelOpen,
    apiState,
    dbState,
    pulsingNavItem,
    triggerNavAnimation,
    handleSidebarNavigate,
    currentNavItem,
    theme,
    setTheme,
    iconColor,
    setIconColor,
    isIconColorSaving,
    iconColorError,
    clearIconColorError,
  };

  return (
    <TipQueueProvider>
      <TipsVersionInit />
      <Outlet context={context} />
      <ReleaseAvailableToast />
      <UpdateAvailableToast />
      {/* Color tokens, close button, and action button styling live in
          `index.css` under `[data-sonner-toaster]` — `richColors` is what
          tells sonner to apply the type-specific (--success-*, --error-*,
          etc) tokens we set there. */}
      <Toaster
        position="bottom-right"
        closeButton
        richColors
        toastOptions={{ duration: 3000 }}
      />
    </TipQueueProvider>
  );
}
