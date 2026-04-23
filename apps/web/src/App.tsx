import { useCallback, useEffect, useRef, useState } from "react";
import {
  Outlet,
  useMatches,
  useNavigate,
  useOutletContext,
} from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import "@xterm/xterm/css/xterm.css";

import { type NavSection } from "@/components/app/sidebar-shell";
import { type Agent, type ServiceState } from "@/components/app/types";
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
import { sortAgentsByCreatedAtDesc } from "@/lib/agent-sort";
import { agentRoute } from "@/lib/agent-routes";
import { UpdateAvailableToast } from "@/components/app/update-available-toast";

type RouteHandle = {
  navSection?: NavSection;
};

export type DashboardContextValue = {
  agents: Agent[];
  enabledAgentTypes: AgentType[];
  setEnabledAgentTypes: React.Dispatch<React.SetStateAction<AgentType[]>>;
  handleLogout: () => void;
  isMobile: boolean;
  leftOpen: boolean;
  mediaOpen: boolean;
  leftPanelOpen: boolean;
  mediaPanelOpen: boolean;
  mobileLeftOpen: boolean;
  mobileMediaOpen: boolean;
  setLeftOpen: (open: boolean) => void;
  setMediaOpen: (open: boolean) => void;
  setMobileLeftOpen: (open: boolean) => void;
  setMobileMediaOpen: (open: boolean) => void;
  handleSetLeftPanelOpen: (open: boolean) => void;
  handleSetMediaPanelOpen: (open: boolean) => void;
  apiState: ServiceState;
  dbState: ServiceState;
  pulsingNavItem: string | null;
  triggerNavAnimation: (navItem: string) => void;
  handleSidebarNavigate: (section: NavSection) => void;
  currentNavItem: NavSection | null;
  theme: ReturnType<typeof useTheme>["theme"];
  setTheme: ReturnType<typeof useTheme>["setTheme"];
  iconColor: ReturnType<typeof useIconColor>["iconColor"];
  setIconColor: ReturnType<typeof useIconColor>["setIconColor"];
  isIconColorSaving: boolean;
  iconColorError: string | null;
  clearIconColorError: () => void;
};

export function useDashboardContext(): DashboardContextValue {
  return useOutletContext<DashboardContextValue>();
}

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
  } = useLayout();
  const { apiState, dbState } = useHealth(true);

  const [enabledAgentTypes, setEnabledAgentTypes] = useState<AgentType[]>([
    ...AGENT_TYPES,
  ]);
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
      else if (section === "jobs") navigate("/jobs");
      else if (section === "activity") navigate("/activity/metrics");
      else if (section === "settings") navigate("/settings");
    },
    [navigate]
  );

  const context: DashboardContextValue = {
    agents,
    enabledAgentTypes,
    setEnabledAgentTypes,
    handleLogout,
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
    <>
      <Outlet context={context} />
      <UpdateAvailableToast />
    </>
  );
}

export async function openAgentFromJobs(
  navigate: ReturnType<typeof useNavigate>,
  agent: Agent
): Promise<void> {
  navigate(agentRoute(agent.id));
}
