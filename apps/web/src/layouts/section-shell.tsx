import { PanelRightOpen } from "lucide-react";
import { type NavSection } from "@/components/app/sidebar-shell";
import { NavigationSidebar } from "@/components/app/navigation-sidebar";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import { useDashboardContext } from "@/components/app/dashboard-context";

export function SectionShell({
  activeSection,
  sidebar,
  headerActions,
  children,
}: {
  activeSection?: NavSection;
  sidebar?: React.ReactNode;
  headerActions?: React.ReactNode;
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

        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {headerActions ? (
            <div className="flex min-h-14 shrink-0 items-center justify-between px-3">
              <div>
                {!leftPanelOpen ? (
                  <IconButton
                    onClick={() => handleSetLeftPanelOpen(true)}
                    label="Open sidebar"
                  >
                    <PanelRightOpen />
                  </IconButton>
                ) : null}
              </div>
              <div className="flex items-center gap-1">{headerActions}</div>
            </div>
          ) : null}
          {!leftPanelOpen && !headerActions ? (
            <div className="pointer-events-none absolute left-3 top-3 z-sticky">
              <IconButton
                className="pointer-events-auto"
                onClick={() => handleSetLeftPanelOpen(true)}
                label="Open sidebar"
              >
                <PanelRightOpen />
              </IconButton>
            </div>
          ) : null}
          <div
            className={cn(
              "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
              !leftPanelOpen && !headerActions && "pt-14"
            )}
          >
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
