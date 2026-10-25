import { useCallback } from "react";
import { type NavSection } from "@/components/app/sidebar-shell";
import { useProjectNavigate } from "@/hooks/use-projects";

const SECTION_PATHS: Record<NavSection, string> = {
  agents: "/agents",
  tasks: "/tasks",
  automations: "/automations",
  activity: "/activity/metrics",
  settings: "/settings",
};

/**
 * The nav bar's section taps. On a phone the nav sits in the sidebar sheet,
 * and a tap is a request for the section's content, so the sheet closes on
 * the way; its toggle opens it again. Agents is the one section that brings
 * the sheet back itself, when no agent is selected and its pane is empty.
 */
export function useSectionNavigate({
  isMobile,
  setMobileLeftOpen,
}: {
  isMobile: boolean;
  setMobileLeftOpen: (open: boolean) => void;
}): (section: NavSection) => void {
  const navigate = useProjectNavigate();
  return useCallback(
    (section: NavSection) => {
      if (isMobile) setMobileLeftOpen(false);
      navigate(SECTION_PATHS[section]);
    },
    [isMobile, navigate, setMobileLeftOpen]
  );
}
