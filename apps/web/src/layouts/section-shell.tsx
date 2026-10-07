import { PanelRightOpen } from "lucide-react";
import { type NavSection } from "@/components/app/sidebar-shell";
import { NavigationSidebar } from "@/components/app/navigation-sidebar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useDashboardContext } from "@/components/app/dashboard-context";

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

        <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          {!leftPanelOpen ? (
            <div className="pointer-events-none absolute left-3 top-3 z-10">
              <Button
                size="icon"
                variant="ghost"
                className="pointer-events-auto"
                onClick={() => handleSetLeftPanelOpen(true)}
                title="Open sidebar"
              >
                <PanelRightOpen className="h-4 w-4" />
              </Button>
            </div>
          ) : null}
          <div
            className={cn(
              "flex h-full min-h-0 min-w-0 flex-col overflow-hidden",
              !leftPanelOpen && "pt-14"
            )}
          >
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
