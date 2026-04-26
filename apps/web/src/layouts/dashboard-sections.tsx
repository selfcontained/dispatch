import { lazy, Suspense, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { BarChart3, History, PanelRightOpen } from "lucide-react";

import { AgentsView } from "@/components/app/agents-view";
import { ActivityPane } from "@/components/app/activity-pane";
import {
  JobsProvider,
  JobListContent,
  JobDetailPane,
} from "@/components/app/jobs-pane";
import {
  SettingsContent,
  SettingsNavContent,
  useSettingsState,
} from "@/components/app/settings-pane";
import { type NavSection, SidebarShell } from "@/components/app/sidebar-shell";
import { type ServiceState } from "@/components/app/types";
import { GlassSidebar } from "@/components/ui/glass-sidebar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useDashboardContext } from "@/App";
import { agentRoute } from "@/lib/agent-routes";

const DesignLab = lazy(async () => {
  const module = await import("@/components/app/design-lab");
  return { default: module.DesignLab };
});

function serviceDotClass(state: ServiceState): string {
  if (state === "ok") return "bg-status-working";
  if (state === "down") return "bg-status-blocked";
  return "bg-status-waiting";
}

function SectionShell({
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
    setMobileMediaOpen,
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

export function AgentsRoute(): JSX.Element {
  const context = useDashboardContext();

  return (
    <AgentsView
      enabledAgentTypes={context.enabledAgentTypes}
      isMobile={context.isMobile}
      leftOpen={context.leftOpen}
      mediaOpen={context.mediaOpen}
      leftPanelOpen={context.leftPanelOpen}
      mediaPanelOpen={context.mediaPanelOpen}
      mobileLeftOpen={context.mobileLeftOpen}
      mobileMediaOpen={context.mobileMediaOpen}
      setLeftOpen={context.setLeftOpen}
      setMediaOpen={context.setMediaOpen}
      setMobileLeftOpen={context.setMobileLeftOpen}
      setMobileMediaOpen={context.setMobileMediaOpen}
      handleSetLeftPanelOpen={context.handleSetLeftPanelOpen}
      handleSetMediaPanelOpen={context.handleSetMediaPanelOpen}
      pulsingNavItem={context.pulsingNavItem}
      triggerNavAnimation={context.triggerNavAnimation}
      onNavigateSection={context.handleSidebarNavigate}
    />
  );
}

export function JobsRoute(): JSX.Element {
  const navigate = useNavigate();
  const { agents, enabledAgentTypes, isMobile, setMobileLeftOpen } =
    useDashboardContext();
  const openAgent = useCallback(
    async (agent: (typeof agents)[number]) => {
      navigate(agentRoute(agent.id));
    },
    [navigate]
  );

  return (
    <JobsProvider
      open={true}
      agents={agents}
      onOpenAgent={openAgent}
      enabledAgentTypes={enabledAgentTypes}
    >
      <SectionShell
        activeSection="jobs"
        sidebar={
          <JobListContent
            onItemSelect={isMobile ? () => setMobileLeftOpen(false) : undefined}
          />
        }
      >
        <JobDetailPane />
      </SectionShell>
    </JobsProvider>
  );
}

export function SettingsRoute(): JSX.Element {
  const navigate = useNavigate();
  const { section, subsection } = useParams();
  const context = useDashboardContext();
  const { activeSection, setActiveSectionState, isAdmin, sections } =
    useSettingsState(true, section);

  const handleSettingsSectionChange = useCallback(
    (nextSection: string | null) => {
      if (!nextSection) return;
      setActiveSectionState(
        nextSection as Parameters<typeof setActiveSectionState>[0]
      );
      navigate(`/settings/${nextSection}`, { replace: true });
      if (context.isMobile) context.setMobileLeftOpen(false);
    },
    [context, navigate, setActiveSectionState]
  );

  return (
    <SectionShell
      activeSection="settings"
      sidebar={
        <SettingsNavContent
          activeSection={activeSection}
          activeSubsection={subsection}
          sections={sections}
          onSectionChange={handleSettingsSectionChange}
          onSubsectionChange={(nextSubsection) => {
            navigate(`/settings/help/${nextSubsection}`, { replace: true });
            if (context.isMobile) context.setMobileLeftOpen(false);
          }}
          apiState={context.apiState}
          dbState={context.dbState}
          serviceDotClass={serviceDotClass}
        />
      }
    >
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <SettingsContent
          activeSection={activeSection}
          onLogout={context.handleLogout}
          theme={context.theme}
          setTheme={context.setTheme}
          iconColor={context.iconColor}
          setIconColor={context.setIconColor}
          isIconColorSaving={context.isIconColorSaving}
          iconColorError={context.iconColorError}
          clearIconColorError={context.clearIconColorError}
          enabledAgentTypes={context.enabledAgentTypes}
          onEnabledAgentTypesChange={context.setEnabledAgentTypes}
          initialSubsection={subsection}
          onSubsectionChange={(nextSubsection) => {
            if (section !== "help") return;
            navigate(
              nextSubsection
                ? `/settings/help/${nextSubsection}`
                : "/settings/help",
              { replace: true }
            );
          }}
          isAdmin={isAdmin}
        />
      </div>
    </SectionShell>
  );
}

export function ActivityRoute(): JSX.Element {
  const navigate = useNavigate();
  const { tab } = useParams();
  const { isMobile, setMobileLeftOpen } = useDashboardContext();
  const activityTab = tab as "metrics" | "history" | undefined;

  return (
    <SectionShell
      activeSection="activity"
      sidebar={
        <div className="flex h-full min-h-0 flex-col">
          <div className="mt-2 flex h-14 items-center border-b border-border px-3">
            <div className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Activity
            </div>
          </div>
          <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            <button
              type="button"
              onClick={() => {
                if (isMobile) setMobileLeftOpen(false);
                navigate("/activity/metrics", { replace: true });
              }}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm transition-colors",
                (activityTab ?? "metrics") === "metrics"
                  ? "bg-primary/10 text-foreground border border-primary/20"
                  : "border border-transparent text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
              )}
            >
              <BarChart3 className="h-3.5 w-3.5 shrink-0" />
              Metrics
            </button>
            <button
              type="button"
              onClick={() => {
                if (isMobile) setMobileLeftOpen(false);
                navigate("/activity/history", { replace: true });
              }}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm transition-colors",
                activityTab === "history"
                  ? "bg-primary/10 text-foreground border border-primary/20"
                  : "border border-transparent text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
              )}
            >
              <History className="h-3.5 w-3.5 shrink-0" />
              History
            </button>
          </nav>
        </div>
      }
    >
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <ActivityPane open={true} initialTab={activityTab} />
      </div>
    </SectionShell>
  );
}

export function DesignLabRoute(): JSX.Element {
  return (
    <SectionShell>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        <Suspense
          fallback={
            <div className="p-8 text-sm text-muted-foreground">
              Loading design lab…
            </div>
          }
        >
          <DesignLab />
        </Suspense>
      </div>
    </SectionShell>
  );
}
