import { useCallback, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { AlarmClock, Brain, FormInput, Play } from "lucide-react";
import { motion } from "framer-motion";

import { JobsProvider } from "@/components/app/jobs-context";
import { JobListContent } from "@/components/app/jobs-list-content";
import { JobDetailPane } from "@/components/app/jobs-detail-pane";
import {
  BrainsListContent,
  BrainsDetailPane,
} from "@/components/app/brains-pane";
import { CreateTemplateDialog } from "@/components/app/automations-create-dialog";
import { LaunchTemplateDialog } from "@/components/app/automations-launch-dialog";
import { TemplateDetailPane } from "@/components/app/automations-template-detail";
import type { AgentType } from "@/lib/agent-types";
import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { useTemplates, type Template } from "@/hooks/use-templates";
import { agentRoute } from "@/lib/agent-routes";
import { cn } from "@/lib/utils";

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
        <div className="flex w-full gap-1 rounded-lg bg-white/[0.04] p-0.5">
          <TabButton
            active={activeTab === "templates"}
            onClick={() => onTabChange("templates")}
            icon={<FormInput className="h-3.5 w-3.5" />}
            label="Templates"
          />
          <TabButton
            active={activeTab === "jobs"}
            onClick={() => onTabChange("jobs")}
            icon={<AlarmClock className="h-3.5 w-3.5" />}
            label="Jobs"
          />
          <TabButton
            active={activeTab === "brains"}
            onClick={() => onTabChange("brains")}
            icon={<Brain className="h-3.5 w-3.5" />}
            label="Brains"
          />
        </div>
      </div>
      {activeTab === "templates" ? (
        <TemplateListContent
          enabledAgentTypes={enabledAgentTypes}
          onItemSelect={onItemSelect}
        />
      ) : activeTab === "jobs" ? (
        <JobListContent onItemSelect={onItemSelect} hideHeader />
      ) : (
        <BrainsListContent onItemSelect={onItemSelect} />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
        active ? "text-primary" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {active ? (
        <motion.div
          layoutId="automations-tab-indicator"
          className="absolute inset-0 rounded-md bg-primary/15"
          transition={{ type: "spring", bounce: 0.15, duration: 0.4 }}
        />
      ) : null}
      <span className="relative z-10 flex items-center gap-1.5">
        {icon}
        {label}
      </span>
    </button>
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
  const navigate = useNavigate();
  const { templateId } = useParams<{ templateId?: string }>();
  const { data: templates = [], isLoading } = useTemplates();
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-end px-3 py-2">
        <Button
          size="sm"
          variant="default"
          className="bg-muted/35 text-muted-foreground hover:bg-muted/65 hover:text-foreground"
          onClick={() => setShowCreate(true)}
        >
          <FormInput className="mr-1 h-4 w-4" />
          Create
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 3 }, (_, i) => (
              <div
                key={i}
                className="h-10 animate-pulse rounded-md bg-muted/40"
              />
            ))}
          </div>
        ) : templates.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            <div className="rounded-md border border-dashed border-border p-4">
              <div className="font-medium text-foreground">
                No templates yet.
              </div>
              <div className="mt-1 text-xs">
                Create a template to launch agents with saved configurations.
              </div>
            </div>
          </div>
        ) : (
          <div>
            {templates.map((template) => (
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
            ))}
          </div>
        )}
      </div>
      <CreateTemplateDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        enabledAgentTypes={enabledAgentTypes}
      />
    </div>
  );
}

function TemplateListItem({
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
          "group w-full cursor-pointer border-b border-r-4 border-border border-r-transparent px-3 py-2 text-left transition-colors hover:bg-muted/40",
          selected && "border-r-primary bg-muted/60"
        )}
      >
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold leading-5">
              {template.name}
            </div>
            {template.description ? (
              <div className="truncate text-xs text-muted-foreground">
                {template.description}
              </div>
            ) : (
              <div
                className="truncate font-mono text-[11px] text-muted-foreground"
                title={template.directory}
              >
                {shortPath(template.directory)}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={handleLaunch}
            title="Launch template"
            className="shrink-0 rounded p-2 text-muted-foreground opacity-0 pointer-events-none transition-opacity hover:bg-white/[0.08] hover:text-primary group-hover:opacity-100 group-hover:pointer-events-auto"
          >
            <Play className="h-3 w-3 fill-current" />
          </button>
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

function shortPath(value: string): string {
  const parts = value.split("/").filter(Boolean);
  if (parts.length <= 3) return value;
  return `.../${parts.slice(-3).join("/")}`;
}

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
  const navigate = useNavigate();
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
      navigate(agentRoute(agent.id));
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
  const navigate = useNavigate();
  const location = useLocation();
  const activeTab = resolveTab(location.pathname);

  const openAgent = useCallback(
    async (agent: Agent) => {
      navigate(agentRoute(agent.id));
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
