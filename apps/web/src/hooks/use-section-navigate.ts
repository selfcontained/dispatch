import { useCallback, useRef } from "react";
import { type NavSection } from "@/components/app/sidebar-shell";
import { useAtom } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { agentRoute } from "@/lib/agent-routes";
import { isAgentInScope } from "@/lib/agent-selection";
import { lastAgentIdAtomFamily } from "@/lib/store";
import { agentListQuery } from "@/hooks/use-agents";
import { useProjectNavigate, useProjectScope } from "@/hooks/use-projects";

const SECTION_PATHS: Record<NavSection, string> = {
  agents: "/agents",
  tasks: "/tasks",
  automations: "/automations",
  activity: "/activity/metrics",
  settings: "/settings",
};

// Automations lands on its Templates tab with none selected: the pane is a
// "Select a template" prompt and the list is the sheet, so the sheet stays.
const KEEPS_SHEET = new Set<NavSection>(["automations"]);

/**
 * The nav bar's section taps. On a phone the nav sits in the sidebar sheet,
 * and a tap is a request for the section's content, so the sheet closes on
 * the way; its toggle opens it again. The exceptions land on an empty pane
 * whose list is the sheet: Automations keeps it, and Agents brings it back
 * itself while no agent is selected.
 */
export function useSectionNavigate({
  isMobile,
  setMobileLeftOpen,
}: {
  isMobile: boolean;
  setMobileLeftOpen: (open: boolean) => void;
}): (section: NavSection) => void {
  const navigate = useProjectNavigate();
  const { projectId } = useProjectScope();
  const [rememberedId, remember] = useAtom(lastAgentIdAtomFamily(projectId));
  const client = useQueryClient();
  const location = useLocation();
  const currentLocation = useRef(location);
  currentLocation.current = location;
  const request = useRef(0);
  return useCallback(
    (section: NavSection) => {
      const navigationRequest = ++request.current;
      if (isMobile && !KEEPS_SHEET.has(section)) setMobileLeftOpen(false);
      if (section !== "agents" || !rememberedId) {
        navigate(SECTION_PATHS[section]);
        return;
      }
      // Usually already loaded by the dashboard. A cold Tasks entry may still
      // be loading; wait for that list without letting it override a later tap,
      // browser history navigation, or project switch.
      void client.ensureQueryData(agentListQuery).then(
        (agents) => {
          if (
            request.current !== navigationRequest ||
            currentLocation.current !== location
          )
            return;
          const valid = agents.some(
            (agent) =>
              agent.id === rememberedId && isAgentInScope(agent, projectId)
          );
          if (!valid) remember(null);
          navigate(
            `${valid ? agentRoute(rememberedId) : "/agents"}?project=${encodeURIComponent(projectId ?? "")}`
          );
        },
        () => {
          if (
            request.current === navigationRequest &&
            currentLocation.current === location
          )
            navigate("/agents");
        }
      );
    },
    [
      client,
      isMobile,
      location,
      navigate,
      projectId,
      remember,
      rememberedId,
      setMobileLeftOpen,
    ]
  );
}
