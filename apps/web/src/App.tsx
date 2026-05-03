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
import { type IdeType, sanitizeEnabledIdes } from "@/lib/ide-types";
import { sortAgentsByCreatedAtDesc } from "@/lib/agent-sort";
import { agentRoute } from "@/lib/agent-routes";
import { UpdateAvailableToast } from "@/components/app/update-available-toast";
import { Toaster } from "sonner";

type RouteHandle = {
  navSection?: NavSection;
};

export type DashboardContextValue = {
  agents: Agent[];
  enabledAgentTypes: AgentType[];
  setEnabledAgentTypes: React.Dispatch<React.SetStateAction<AgentType[]>>;
  enabledIdes: IdeType[];
  setEnabledIdes: React.Dispatch<React.SetStateAction<IdeType[]>>;
  handleLogout: () => void;
  isMobile: boolean;
  leftOpen: boolean;
  leftPanelOpen: boolean;
  mobileLeftOpen: boolean;
  mobileMediaOpen: boolean;
  setLeftOpen: (open: boolean) => void;
  setMobileLeftOpen: (open: boolean) => void;
  setMobileMediaOpen: (open: boolean) => void;
  handleSetLeftPanelOpen: (open: boolean) => void;
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
    <>
      <Outlet context={context} />
      <UpdateAvailableToast />
      <Toaster
        position="bottom-right"
        closeButton
        richColors
        toastOptions={{
          duration: 3000,
          classNames: {
            // Pin the close button onto a dark contrasting surface so the
            // X is readable on the bright status-color toast bg. The
            // border is intentionally NOT overridden — sonner inherits it
            // from the toast type's `--*-border` (which equals the toast
            // bg in our setup), so the close button reads as a dark disc
            // ringed in the toast's accent color, visually tying the two.
            // `!important` is required because sonner's injected
            // stylesheet sets these via attribute selectors with higher
            // specificity than utility classes.
            closeButton: "!bg-background !text-foreground hover:!bg-muted",
            // Match the action button to the close button so the two
            // interactive elements read as a pair against the bright
            // toast bg (sonner defaults action buttons to white-ish on
            // dark, which competes with the body text).
            actionButton: "!bg-background !text-foreground hover:!bg-muted",
          },
        }}
        // Drive sonner's color tokens off the project's theme variables so
        // toasts pick up whatever palette the user has selected, rather
        // than sonner's hardcoded light/dark `richColors` palette.
        // `richColors` is needed for sonner to apply the type-specific
        // (--success-*, --error-*, etc) tokens — without it every toast
        // would use --normal-* regardless of type.
        style={
          {
            // Default ("normal") toast — neutral card surface.
            "--normal-bg": "hsl(var(--card))",
            "--normal-text": "hsl(var(--card-foreground))",
            "--normal-border": "hsl(var(--border))",
            // Typed toasts use the status color as the bg so they stand
            // out clearly. The project's status palette is bright in both
            // themes, so a dark `--background` text color stays readable.
            // Success → `--status-working` (the green token, consistent
            // across themes — `--status-done` is blue/cyan in some themes).
            "--success-bg": "hsl(var(--status-working))",
            "--success-text": "hsl(var(--background))",
            "--success-border": "hsl(var(--status-working))",
            // Info → `--status-done` (blue/cyan in most themes; visually
            // distinct from the green success accent).
            "--info-bg": "hsl(var(--status-done))",
            "--info-text": "hsl(var(--background))",
            "--info-border": "hsl(var(--status-done))",
            "--warning-bg": "hsl(var(--status-waiting))",
            "--warning-text": "hsl(var(--background))",
            "--warning-border": "hsl(var(--status-waiting))",
            "--error-bg": "hsl(var(--status-blocked))",
            "--error-text": "hsl(var(--background))",
            "--error-border": "hsl(var(--status-blocked))",
          } as React.CSSProperties
        }
      />
    </>
  );
}

export async function openAgentFromJobs(
  navigate: ReturnType<typeof useNavigate>,
  agent: Agent
): Promise<void> {
  navigate(agentRoute(agent.id));
}
