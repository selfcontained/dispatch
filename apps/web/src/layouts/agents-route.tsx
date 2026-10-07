import { AgentsView } from "@/components/app/agents-view";
import { useDashboardContext } from "@/components/app/dashboard-context";

export function AgentsRoute(): JSX.Element {
  const context = useDashboardContext();

  return (
    <AgentsView
      enabledAgentTypes={context.enabledAgentTypes}
      enabledIdes={context.enabledIdes}
      isMobile={context.isMobile}
      leftOpen={context.leftOpen}
      leftPanelOpen={context.leftPanelOpen}
      mobileLeftOpen={context.mobileLeftOpen}
      mobileDrawerOpen={context.mobileDrawerOpen}
      setLeftOpen={context.setLeftOpen}
      setMobileLeftOpen={context.setMobileLeftOpen}
      setMobileDrawerOpen={context.setMobileDrawerOpen}
      handleSetLeftPanelOpen={context.handleSetLeftPanelOpen}
      pulsingNavItem={context.pulsingNavItem}
      triggerNavAnimation={context.triggerNavAnimation}
      onNavigateSection={context.handleSidebarNavigate}
    />
  );
}
