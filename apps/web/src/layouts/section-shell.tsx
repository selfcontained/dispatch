import { PanelRightOpen } from "lucide-react";
import { type NavSection, SidebarShell } from "@/components/app/sidebar-shell";
import { GlassSidebar } from "@/components/ui/glass-sidebar";
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
        <GlassSidebar
          open={isMobile ? mobileLeftOpen : leftOpen}
          onOpenChange={(open) => {
            if (isMobile) {
              if (open) setMobileDrawerOpen(false);
              setMobileLeftOpen(open);
            } else {
              setLeftOpen(open);
            }
          }}
          side="left"
          width={320}
          mobile={isMobile}
          label="Navigation sidebar"
        >
          <SidebarShell
            activeSection={activeSection}
            onNavigate={handleSidebarNavigate}
            onRequestClose={
              isMobile
                ? () => setMobileLeftOpen(false)
                : () => setLeftOpen(false)
            }
            closeButtonIcon={isMobile ? "x" : "chevron"}
            pulsingNavItem={pulsingNavItem}
            triggerNavAnimation={triggerNavAnimation}
          >
            {sidebar}
          </SidebarShell>
        </GlassSidebar>

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
