import { useCallback, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  AlarmClock,
  FileText,
  Pencil,
  Play,
  Plus,
  Trash2,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import {
  JobsProvider,
  JobListContent,
  JobDetailPane,
} from "@/components/app/jobs-pane";
import { PathInput } from "@/components/app/path-input";
import type { AgentType } from "@/lib/agent-types";
import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  useTemplates,
  useTemplateActions,
  parseTemplateArgs,
  type Template,
  type TemplateArg,
} from "@/hooks/use-templates";
import {
  AGENT_TYPE_LABELS,
  type CliAgentType,
  isCliAgentType,
} from "@/lib/agent-types";
import { agentRoute } from "@/lib/agent-routes";
import { cn } from "@/lib/utils";

type AutomationsTab = "templates" | "jobs";

function resolveTab(pathname: string): AutomationsTab {
  if (
    pathname.startsWith("/automations/jobs") ||
    pathname === "/automations/jobs"
  ) {
    return "jobs";
  }
  return "templates";
}

// ---------------------------------------------------------------------------
// Automations sidebar (tabs + list)
// ---------------------------------------------------------------------------

function AutomationsSidebar({
  activeTab,
  onTabChange,
  onItemSelect,
}: {
  activeTab: AutomationsTab;
  onTabChange: (tab: AutomationsTab) => void;
  onItemSelect?: () => void;
}): JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mt-2 flex h-14 items-center border-b border-border px-3">
        <div className="flex w-full gap-1 rounded-lg bg-white/[0.04] p-0.5">
          <TabButton
            active={activeTab === "templates"}
            onClick={() => onTabChange("templates")}
            icon={<Zap className="h-3.5 w-3.5" />}
            label="Templates"
          />
          <TabButton
            active={activeTab === "jobs"}
            onClick={() => onTabChange("jobs")}
            icon={<AlarmClock className="h-3.5 w-3.5" />}
            label="Jobs"
          />
        </div>
      </div>
      {activeTab === "templates" ? (
        <TemplateListContent onItemSelect={onItemSelect} />
      ) : (
        <JobListContent onItemSelect={onItemSelect} />
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
        "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
        active
          ? "bg-primary/15 text-primary"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Template list
// ---------------------------------------------------------------------------

function TemplateListContent({
  onItemSelect,
}: {
  onItemSelect?: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const { templateId } = useParams<{ templateId?: string }>();
  const { data: templates = [] } = useTemplates();
  const [showCreate, setShowCreate] = useState(false);

  const callableTemplates = useMemo(
    () => templates.filter((t) => t.callable),
    [templates]
  );

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2">
        <div className="mb-2 flex items-center justify-between px-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Templates
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => setShowCreate(true)}
          >
            <Plus className="h-3 w-3" />
            Create
          </Button>
        </div>
        {callableTemplates.length === 0 ? (
          <div className="px-2 py-8 text-center text-xs text-muted-foreground">
            No templates yet. Create one to get started.
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {callableTemplates.map((template) => (
              <TemplateListItem
                key={template.id}
                template={template}
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
      <CreateTemplateDialog open={showCreate} onOpenChange={setShowCreate} />
    </>
  );
}

function TemplateListItem({
  template,
  selected,
  onSelect,
}: {
  template: Template;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { launchTemplate } = useTemplateActions();
  const args = useMemo(
    () => (template.prompt ? parseTemplateArgs(template.prompt) : []),
    [template.prompt]
  );

  const handleLaunch = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (args.length > 0) {
        navigate(`/automations/templates/${template.id}`);
        return;
      }
      launchTemplate
        .mutateAsync({ id: template.id })
        .then(async (result) => {
          await queryClient.invalidateQueries({ queryKey: ["agents"] });
          navigate(agentRoute(result.agentId));
        })
        .catch((err: Error) => {
          toast.error(`Failed to launch: ${err.message}`);
        });
    },
    [args.length, launchTemplate, navigate, queryClient, template.id]
  );

  return (
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
        "group flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm transition-colors",
        selected
          ? "border border-primary/20 bg-primary/10 text-foreground"
          : "border border-transparent text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
      )}
    >
      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{template.name}</span>
      <button
        type="button"
        onClick={handleLaunch}
        title="Launch template"
        className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-white/[0.08] hover:text-primary group-hover:opacity-100"
      >
        <Play className="h-3 w-3 fill-current" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Template detail pane
// ---------------------------------------------------------------------------

export function TemplateDetailPane(): JSX.Element {
  const { templateId } = useParams<{ templateId?: string }>();
  const { data: templates = [] } = useTemplates();
  const template = useMemo(
    () => templates.find((t) => t.id === templateId) ?? null,
    [templates, templateId]
  );

  if (!templateId || !template) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a template to view details
      </div>
    );
  }

  return <TemplateDetail template={template} />;
}

function TemplateDetail({ template }: { template: Template }): JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { launchTemplate, removeTemplate } = useTemplateActions();
  const [showEdit, setShowEdit] = useState(false);
  const [showDelete, setShowDelete] = useState(false);

  const args = useMemo(
    () => (template.prompt ? parseTemplateArgs(template.prompt) : []),
    [template.prompt]
  );
  const [argValues, setArgValues] = useState<Record<string, string>>({});

  const handleLaunch = useCallback(() => {
    const launchArgs = args.length > 0 ? argValues : undefined;
    launchTemplate
      .mutateAsync({ id: template.id, args: launchArgs })
      .then(async (result) => {
        await queryClient.invalidateQueries({ queryKey: ["agents"] });
        navigate(agentRoute(result.agentId));
      })
      .catch((err: Error) => {
        toast.error(`Failed to launch: ${err.message}`);
      });
  }, [args, argValues, launchTemplate, navigate, queryClient, template.id]);

  const handleDelete = useCallback(() => {
    removeTemplate
      .mutateAsync(template.id)
      .then(() => {
        navigate("/automations");
        toast.success(`Template "${template.name}" deleted.`);
      })
      .catch((err: Error) => {
        toast.error(`Failed to delete: ${err.message}`);
      });
    setShowDelete(false);
  }, [removeTemplate, template, navigate]);

  const allArgsFilled =
    args.length === 0 || args.every((a) => argValues[a.key]?.trim());

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="border-b border-border px-6 py-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              {template.name}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {shortPath(template.directory)}
            </p>
          </div>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              className="gap-1"
              onClick={() => setShowEdit(true)}
            >
              <Pencil className="h-3 w-3" />
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="gap-1 text-destructive hover:text-destructive"
              onClick={() => setShowDelete(true)}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>

      {/* Launch form */}
      <div className="flex-1 px-6 py-5">
        {args.length > 0 ? (
          <div className="mb-5">
            <h3 className="mb-3 text-sm font-medium text-foreground">
              Arguments
            </h3>
            <div className="flex flex-col gap-3">
              {args.map((arg) => (
                <ArgInput
                  key={arg.key}
                  arg={arg}
                  value={argValues[arg.key] ?? ""}
                  onChange={(value) =>
                    setArgValues((prev) => ({ ...prev, [arg.key]: value }))
                  }
                />
              ))}
            </div>
          </div>
        ) : null}

        <Button
          className="gap-1.5"
          onClick={handleLaunch}
          disabled={!allArgsFilled || launchTemplate.isPending}
        >
          <Play className="h-3.5 w-3.5 fill-current" />
          Launch
        </Button>

        {/* Config summary */}
        <div className="mt-8 space-y-2 text-xs text-muted-foreground">
          <div>
            Agent type:{" "}
            <span className="text-foreground">
              {AGENT_TYPE_LABELS[template.agentType] ?? template.agentType}
            </span>
          </div>
          {template.useWorktree ? (
            <div>
              Worktree:{" "}
              <span className="text-foreground">
                {template.baseBranch ?? "default branch"}
              </span>
            </div>
          ) : null}
          {template.fullAccess ? (
            <div className="text-amber-500/80">Full access enabled</div>
          ) : null}
        </div>

        {template.prompt ? (
          <div className="mt-6">
            <h3 className="mb-2 text-sm font-medium text-foreground">Prompt</h3>
            <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded-md bg-white/[0.04] p-3 text-xs text-muted-foreground">
              {template.prompt}
            </pre>
          </div>
        ) : null}
      </div>

      <EditTemplateDialog
        template={template}
        open={showEdit}
        onOpenChange={setShowEdit}
      />

      <Dialog open={showDelete} onOpenChange={setShowDelete}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete template</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &ldquo;{template.name}&rdquo;?
              This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setShowDelete(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ArgInput({
  arg,
  value,
  onChange,
}: {
  arg: TemplateArg;
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-foreground">
        {arg.name}
      </label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`Enter ${arg.name}`}
        className="h-8 text-sm"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / Edit template dialogs
// ---------------------------------------------------------------------------

function CreateTemplateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const { addTemplate } = useTemplateActions();
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState("");
  const [prompt, setPrompt] = useState("");
  const [agentType, setAgentType] = useState<CliAgentType>("claude");
  const [useWorktree, setUseWorktree] = useState(false);
  const [baseBranch, setBaseBranch] = useState("");
  const [fullAccess, setFullAccess] = useState(false);

  const detectedArgs = useMemo(
    () => (prompt ? parseTemplateArgs(prompt) : []),
    [prompt]
  );

  const handleCreate = useCallback(() => {
    addTemplate
      .mutateAsync({
        name,
        directory,
        prompt: prompt || null,
        agentType,
        useWorktree,
        baseBranch: baseBranch || null,
        fullAccess,
        callable: true,
      })
      .then(() => {
        onOpenChange(false);
        setName("");
        setDirectory("");
        setPrompt("");
        setAgentType("claude");
        setUseWorktree(false);
        setBaseBranch("");
        setFullAccess(false);
        toast.success("Template created.");
      })
      .catch((err: Error) => {
        toast.error(`Failed to create template: ${err.message}`);
      });
  }, [
    addTemplate,
    name,
    directory,
    prompt,
    agentType,
    useWorktree,
    baseBranch,
    fullAccess,
    onOpenChange,
  ]);

  const canCreate = name.trim() && directory.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create template</DialogTitle>
          <DialogDescription>
            A reusable agent launch configuration. Use{" "}
            <code className="rounded bg-white/[0.08] px-1 text-xs">
              {"{{D:Arg Name}}"}
            </code>{" "}
            in the prompt for runtime arguments.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div>
            <label className="mb-1 block text-xs font-medium">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My template"
              className="h-8"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">Directory</label>
            <PathInput
              value={directory}
              onChange={setDirectory}
              placeholder="/path/to/repo"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">Prompt</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe what the agent should do..."
              className="min-h-[100px] w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
            {detectedArgs.length > 0 ? (
              <div className="mt-1.5 text-xs text-muted-foreground">
                Detected arguments:{" "}
                {detectedArgs.map((a) => (
                  <span
                    key={a.key}
                    className="mr-1.5 inline-block rounded bg-primary/10 px-1.5 py-0.5 text-primary"
                  >
                    {a.name}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">Agent type</label>
            <select
              value={agentType}
              onChange={(e) => {
                if (isCliAgentType(e.target.value))
                  setAgentType(e.target.value);
              }}
              className="h-8 w-full rounded-md border border-border bg-transparent px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary/50"
            >
              {Object.entries(AGENT_TYPE_LABELS)
                .filter(([key]) => isCliAgentType(key))
                .map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              checked={useWorktree}
              onCheckedChange={(checked) => setUseWorktree(checked === true)}
              id="create-template-worktree"
            />
            <label
              htmlFor="create-template-worktree"
              className="text-sm text-foreground"
            >
              Use worktree
            </label>
          </div>
          {useWorktree ? (
            <div>
              <label className="mb-1 block text-xs font-medium">
                Base branch
              </label>
              <Input
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                placeholder="main"
                className="h-8"
              />
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <Checkbox
              checked={fullAccess}
              onCheckedChange={(checked) => setFullAccess(checked === true)}
              id="create-template-full-access"
            />
            <label
              htmlFor="create-template-full-access"
              className="text-sm text-foreground"
            >
              Full access
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={!canCreate}>
              Create
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EditTemplateDialog({
  template,
  open,
  onOpenChange,
}: {
  template: Template;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const { updateTemplate } = useTemplateActions();
  const [name, setName] = useState(template.name);
  const [prompt, setPrompt] = useState(template.prompt ?? "");
  const [agentType, setAgentType] = useState<CliAgentType>(template.agentType);
  const [useWorktree, setUseWorktree] = useState(template.useWorktree);
  const [baseBranch, setBaseBranch] = useState(template.baseBranch ?? "");
  const [fullAccess, setFullAccess] = useState(template.fullAccess);
  const [callable, setCallable] = useState(template.callable);

  const detectedArgs = useMemo(
    () => (prompt ? parseTemplateArgs(prompt) : []),
    [prompt]
  );

  const handleSave = useCallback(() => {
    updateTemplate
      .mutateAsync({
        id: template.id,
        name,
        prompt: prompt || null,
        agentType,
        useWorktree,
        baseBranch: baseBranch || null,
        fullAccess,
        callable,
      })
      .then(() => {
        onOpenChange(false);
        toast.success("Template updated.");
      })
      .catch((err: Error) => {
        toast.error(`Failed to update: ${err.message}`);
      });
  }, [
    updateTemplate,
    template.id,
    name,
    prompt,
    agentType,
    useWorktree,
    baseBranch,
    fullAccess,
    callable,
    onOpenChange,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit template</DialogTitle>
          <DialogDescription>
            Modify the template configuration.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div>
            <label className="mb-1 block text-xs font-medium">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-8"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">Prompt</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="min-h-[100px] w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
            {detectedArgs.length > 0 ? (
              <div className="mt-1.5 text-xs text-muted-foreground">
                Detected arguments:{" "}
                {detectedArgs.map((a) => (
                  <span
                    key={a.key}
                    className="mr-1.5 inline-block rounded bg-primary/10 px-1.5 py-0.5 text-primary"
                  >
                    {a.name}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">Agent type</label>
            <select
              value={agentType}
              onChange={(e) => {
                if (isCliAgentType(e.target.value))
                  setAgentType(e.target.value);
              }}
              className="h-8 w-full rounded-md border border-border bg-transparent px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary/50"
            >
              {Object.entries(AGENT_TYPE_LABELS)
                .filter(([key]) => isCliAgentType(key))
                .map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              checked={useWorktree}
              onCheckedChange={(checked) => setUseWorktree(checked === true)}
              id="edit-template-worktree"
            />
            <label
              htmlFor="edit-template-worktree"
              className="text-sm text-foreground"
            >
              Use worktree
            </label>
          </div>
          {useWorktree ? (
            <div>
              <label className="mb-1 block text-xs font-medium">
                Base branch
              </label>
              <Input
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                placeholder="main"
                className="h-8"
              />
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <Checkbox
              checked={fullAccess}
              onCheckedChange={(checked) => setFullAccess(checked === true)}
              id="edit-template-full-access"
            />
            <label
              htmlFor="edit-template-full-access"
              className="text-sm text-foreground"
            >
              Full access
            </label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              checked={callable}
              onCheckedChange={(checked) => setCallable(checked === true)}
              id="edit-template-callable"
            />
            <label
              htmlFor="edit-template-callable"
              className="text-sm text-foreground"
            >
              Show in Cmd+K
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave}>Save</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortPath(value: string): string {
  const home = "/Users/";
  if (value.startsWith(home)) {
    const afterHome = value.slice(home.length);
    const slash = afterHome.indexOf("/");
    return slash === -1 ? `~` : `~${afterHome.slice(slash)}`;
  }
  return value;
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

  if (activeTab === "jobs") {
    return (
      <JobsProvider
        open={true}
        agents={agents}
        onOpenAgent={openAgent}
        enabledAgentTypes={enabledAgentTypes}
      >
        <AutomationsSidebar
          activeTab={activeTab}
          onTabChange={handleTabChange}
          onItemSelect={isMobile ? closeSidebar : undefined}
        />
      </JobsProvider>
    );
  }

  return (
    <AutomationsSidebar
      activeTab={activeTab}
      onTabChange={handleTabChange}
      onItemSelect={isMobile ? closeSidebar : undefined}
    />
  );
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
    return <TemplateDetailPane />;
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
