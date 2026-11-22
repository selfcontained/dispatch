import { useCallback } from "react";

import { type NavSection } from "@/components/app/sidebar-shell";
import { NavigationSidebar } from "@/components/app/navigation-sidebar";
import { SectionChrome } from "@/components/app/section-chrome";
import { useDashboardContext } from "@/components/app/dashboard-context";

/**
 * A section's frame: the navigation, then the page. The page is a PageHeader
 * and a PageContent; this fills in the header's first and last controls.
 */
export function SectionShell({
  activeSection,
  sidebar,
  children,
}: {
  activeSection?: NavSection;
  sidebar?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  const {
    isMobile,
    leftOpen,
    leftPanelOpen,
    mobileLeftOpen,
    setLeftOpen,
    setMobileLeftOpen,
    setMobileDrawerOpen,
    handleSetLeftPanelOpen,
    pulsingNavItem,
    triggerNavAnimation,
    handleSidebarNavigate,
  } = useDashboardContext();
  const openSidebar = useCallback(
    () => handleSetLeftPanelOpen(true),
    [handleSetLeftPanelOpen]
  );

  return (
    <div className="h-full min-h-0 overflow-hidden text-foreground">
      <div className="flex h-full min-h-0 min-w-0 overflow-hidden py-2">
        <NavigationSidebar
          isMobile={isMobile}
          leftOpen={leftOpen}
          mobileLeftOpen={mobileLeftOpen}
          setLeftOpen={setLeftOpen}
          setMobileLeftOpen={setMobileLeftOpen}
          setMobileDrawerOpen={setMobileDrawerOpen}
          pulsingNavItem={pulsingNavItem}
          triggerNavAnimation={triggerNavAnimation}
          activeSection={activeSection}
          onNavigate={handleSidebarNavigate}
        >
          {sidebar}
        </NavigationSidebar>

        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <SectionChrome
            leftPanelOpen={leftPanelOpen}
            onOpenSidebar={openSidebar}
          >
            {children}
          </SectionChrome>
        </main>
      </div>
    </div>
  );
}
