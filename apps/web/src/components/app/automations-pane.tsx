import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { SidebarTop } from "./sidebar-top";
import { useProjectScope } from "@/hooks/use-projects";
import { useProjectNavigate } from "@/hooks/use-projects";
import { useCallback, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { AlarmClock, Brain, FormInput, Play } from "lucide-react";

import { JobsProvider } from "@/components/app/jobs-context";
import { JobListContent } from "@/components/app/jobs-list-content";
import { JobDetailPane } from "@/components/app/jobs-detail-pane";
import { BrainsListContent } from "@/components/app/brains-pane";
import { BrainsDetailPane } from "@/components/app/brains-detail-pane";
import { CreateTemplateDialog } from "@/components/app/automations-create-dialog";
import { LaunchTemplateDialog } from "@/components/app/automations-launch-dialog";
import { TemplateDetailPane } from "@/components/app/automations-template-detail";
import type { AgentType } from "@/lib/agent-types";
import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { useTemplates, type Template } from "@/hooks/use-templates";
import { agentRoute } from "@/lib/agent-routes";
import { shortPath } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AsyncBoundary } from "@/components/ui/async-boundary";
import { EmptyState } from "@/components/ui/empty-state";

type AutomationsTab = "templates" | "jobs" | "brains";

function resolveTab(pathname: string): AutomationsTab {
  if (pathname.startsWith("/automations/jobs")) {
    return "jobs";
  }
  if (pathname.startsWith("/automations/brains")) {
    return "brains";
  }
  return "templates";
}

// ---------------------------------------------------------------------------
// Automations sidebar (tabs + list)
// ---------------------------------------------------------------------------

function AutomationsSidebar({
  activeTab,
  onTabChange,
  enabledAgentTypes,
  onItemSelect,
}: {
  activeTab: AutomationsTab;
  onTabChange: (tab: AutomationsTab) => void;
  enabledAgentTypes: AgentType[];
  onItemSelect?: () => void;
}): JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mt-2 flex h-14 items-center border-b border-border px-3">
        <SegmentedControl
          layout="fill"
          aria-label="Automations"
          value={activeTab}
          onValueChange={onTabChange}
        >
          <SegmentedControlItem value="templates" className="px-1">
            <FormInput />
            Templates
          </SegmentedControlItem>
          <SegmentedControlItem value="jobs" className="px-1">
            <AlarmClock />
            Jobs
          </SegmentedControlItem>
          <SegmentedControlItem value="brains" className="px-1">
            <Brain />
            Brains
          </SegmentedControlItem>
        </SegmentedControl>
      </div>
      {activeTab === "templates" ? (
        <TemplateListContent
          enabledAgentTypes={enabledAgentTypes}
          onItemSelect={onItemSelect}
        />
      ) : activeTab === "jobs" ? (
        <JobListContent onItemSelect={onItemSelect} />
      ) : (
        <BrainsListContent onItemSelect={onItemSelect} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Template list
// ---------------------------------------------------------------------------

function TemplateListContent({
  enabledAgentTypes,
  onItemSelect,
}: {
  enabledAgentTypes: AgentType[];
  onItemSelect?: () => void;
}): JSX.Element {
  const navigate = useProjectNavigate();
  const { templateId } = useParams<{ templateId?: string }>();
  const { projectId } = useProjectScope();
  const query = useTemplates();
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SidebarTop
        action={
          <Button
            size="sm"
            variant="primary"
            onClick={() => setShowCreate(true)}
          >
            <FormInput />
            New template
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <AsyncBoundary
          query={query}
          thing="templates"
          className="m-3"
          isEmpty={(all) =>
            !all.some((t) => !projectId || t.projectId === projectId)
          }
          empty={
            <EmptyState
              title="No templates yet."
              description="Create a template to launch agents with saved configurations."
            />
          }
        >
          {(all) =>
            all
              .filter((t) => !projectId || t.projectId === projectId)
              .map((template) => (
                <TemplateListItem
                  key={template.id}
                  template={template}
                  enabledAgentTypes={enabledAgentTypes}
                  selected={templateId === template.id}
                  onSelect={() => {
                    navigate(`/automations/templates/${template.id}`);
                    onItemSelect?.();
                  }}
                />
              ))
          }
        </AsyncBoundary>
      </div>
      <CreateTemplateDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        enabledAgentTypes={enabledAgentTypes}
      />
    </div>
  );
}

export function TemplateListItem({
  template,
  enabledAgentTypes,
  selected,
  onSelect,
}: {
  template: Template;
  enabledAgentTypes: AgentType[];
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const [launchDialogOpen, setLaunchDialogOpen] = useState(false);
  const { data: location } = useQuery({
    queryKey: ["saved-launch-target", "template", template.id],
    enabled: !template.description,
    queryFn: () =>
      api<{ locationLabel: string }>(
        `/api/v1/launch-targets/saved/template/${encodeURIComponent(template.id)}`
      ),
  });

  const handleLaunch = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setLaunchDialogOpen(true);
  }, []);

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        }}
        className={cn(
          "group w-full cursor-pointer border-b border-r-4 border-border border-r-transparent px-3 py-2 text-left transition-colors hover:bg-surface-hover",
          selected && "border-r-primary bg-surface-hover"
        )}
      >
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-body-md font-semibold leading-5">
              {template.name}
            </div>
            {template.description ? (
              <div className="truncate text-body-sm text-muted-foreground">
                {template.description}
              </div>
            ) : (
              <div
                className="truncate font-mono text-label-sm text-muted-foreground"
                title={location?.locationLabel}
              >
                {shortPath(location?.locationLabel ?? "")}
              </div>
            )}
          </div>
          <IconButton
            size="icon-sm"
            label="Launch template"
            onClick={handleLaunch}
            className="opacity-0 transition-opacity hover:text-primary focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
          >
            <Play className="fill-current" />
          </IconButton>
        </div>
      </div>
      <LaunchTemplateDialog
        template={template}
        open={launchDialogOpen}
        onOpenChange={setLaunchDialogOpen}
        agentTypes={enabledAgentTypes}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// Main automations pane (exported)
// ---------------------------------------------------------------------------

export function AutomationsSidebarContent({
  agents,
  enabledAgentTypes,
  isMobile,
  closeSidebar,
}: {
  agents: Agent[];
  enabledAgentTypes: AgentType[];
  isMobile: boolean;
  closeSidebar?: () => void;
}): JSX.Element {
  const navigate = useProjectNavigate();
  const location = useLocation();
  const activeTab = resolveTab(location.pathname);

  const handleTabChange = useCallback(
    (tab: AutomationsTab) => {
      if (tab === "jobs") {
        navigate("/automations/jobs");
      } else if (tab === "brains") {
        navigate("/automations/brains");
      } else {
        navigate("/automations");
      }
    },
    [navigate]
  );

  const openAgent = useCallback(
    async (agent: Agent) => {
      navigate(
        `${agentRoute(agent.id)}?project=${encodeURIComponent(agent.projectId ?? "")}`
      );
    },
    [navigate]
  );

  const sidebar = (
    <AutomationsSidebar
      activeTab={activeTab}
      onTabChange={handleTabChange}
      enabledAgentTypes={enabledAgentTypes}
      onItemSelect={isMobile ? closeSidebar : undefined}
    />
  );

  if (activeTab === "jobs") {
    return (
      <JobsProvider
        open={true}
        agents={agents}
        onOpenAgent={openAgent}
        enabledAgentTypes={enabledAgentTypes}
      >
        {sidebar}
      </JobsProvider>
    );
  }

  return sidebar;
}

export function AutomationsDetailContent({
  agents,
  enabledAgentTypes,
}: {
  agents: Agent[];
  enabledAgentTypes: AgentType[];
}): JSX.Element {
  const navigate = useProjectNavigate();
  const location = useLocation();
  const activeTab = resolveTab(location.pathname);

  const openAgent = useCallback(
    async (agent: Agent) => {
      navigate(
        `${agentRoute(agent.id)}?project=${encodeURIComponent(agent.projectId ?? "")}`
      );
    },
    [navigate]
  );

  if (activeTab === "templates") {
    return <TemplateDetailPane enabledAgentTypes={enabledAgentTypes} />;
  }

  if (activeTab === "brains") {
    return <BrainsDetailPane />;
  }

  return (
    <JobsProvider
      open={true}
      agents={agents}
      onOpenAgent={openAgent}
      enabledAgentTypes={enabledAgentTypes}
    >
      <JobDetailPane />
    </JobsProvider>
  );
}
