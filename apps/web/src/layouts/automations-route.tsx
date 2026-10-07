import {
  AutomationsSidebarContent,
  AutomationsDetailContent,
} from "@/components/app/automations-pane";
import { SectionShell } from "./section-shell";
import { useDashboardContext } from "@/components/app/dashboard-context";

export function AutomationsRoute(): JSX.Element {
  const { agents, enabledAgentTypes, isMobile, setMobileLeftOpen } =
    useDashboardContext();

  return (
    <SectionShell
      activeSection="automations"
      sidebar={
        <AutomationsSidebarContent
          agents={agents}
          enabledAgentTypes={enabledAgentTypes}
          isMobile={isMobile}
          closeSidebar={() => setMobileLeftOpen(false)}
        />
      }
    >
      <AutomationsDetailContent
        agents={agents}
        enabledAgentTypes={enabledAgentTypes}
      />
    </SectionShell>
  );
}
