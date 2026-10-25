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
  return useCallback(
    (section: NavSection) => {
      if (isMobile && !KEEPS_SHEET.has(section)) setMobileLeftOpen(false);
      navigate(SECTION_PATHS[section]);
    },
    [isMobile, navigate, setMobileLeftOpen]
  );
}
