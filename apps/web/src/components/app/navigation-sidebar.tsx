import type { DashboardContextValue } from "@/components/app/dashboard-context";
import { type NavSection, SidebarShell } from "@/components/app/sidebar-shell";
import { GlassSidebar } from "@/components/ui/glass-sidebar";

type NavigationSidebarProps = Pick<
  DashboardContextValue,
  | "isMobile"
  | "leftOpen"
  | "mobileLeftOpen"
  | "setLeftOpen"
  | "setMobileLeftOpen"
  | "setMobileMediaOpen"
  | "pulsingNavItem"
  | "triggerNavAnimation"
> & {
  activeSection?: NavSection;
  onNavigate: (section: NavSection) => void;
  children: React.ReactNode;
};

/**
 * The left navigation sidebar shared by the agents view and every other
 * dashboard section: a GlassSidebar that switches between the desktop panel
 * and the mobile slide-over, wrapping the SidebarShell nav chrome.
 */
export function NavigationSidebar({
  isMobile,
  leftOpen,
  mobileLeftOpen,
  setLeftOpen,
  setMobileLeftOpen,
  setMobileMediaOpen,
  pulsingNavItem,
  triggerNavAnimation,
  activeSection,
  onNavigate,
  children,
}: NavigationSidebarProps): JSX.Element {
  return (
    <GlassSidebar
      open={isMobile ? mobileLeftOpen : leftOpen}
      onOpenChange={(open) => {
        if (isMobile) {
          if (open) setMobileMediaOpen(false);
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
        onNavigate={onNavigate}
        onRequestClose={
          isMobile ? () => setMobileLeftOpen(false) : () => setLeftOpen(false)
        }
        closeButtonIcon={isMobile ? "x" : "chevron"}
        pulsingNavItem={pulsingNavItem}
        triggerNavAnimation={triggerNavAnimation}
      >
        {children}
      </SidebarShell>
    </GlassSidebar>
  );
}
