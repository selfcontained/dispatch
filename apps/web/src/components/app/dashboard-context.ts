import type { Dispatch, SetStateAction } from "react";
import { useOutletContext } from "react-router-dom";

import type { NavSection } from "@/components/app/sidebar-shell";
import type { Agent, ServiceState } from "@/components/app/types";
import type { AgentType } from "@/lib/agent-types";
import type { IdeType } from "@/lib/ide-types";
import type { useIconColor } from "@/hooks/use-icon-color";
import type { useTheme } from "@/hooks/use-theme";

export type DashboardContextValue = {
  agents: Agent[];
  enabledAgentTypes: AgentType[];
  setEnabledAgentTypes: Dispatch<SetStateAction<AgentType[]>>;
  enabledIdes: IdeType[];
  setEnabledIdes: Dispatch<SetStateAction<IdeType[]>>;
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
