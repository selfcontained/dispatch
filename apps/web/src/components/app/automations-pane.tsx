import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  AlarmClock,
  Check,
  ChevronDown,
  FormInput,
  GitBranch,
  Play,
  Trash2,
} from "lucide-react";
import { motion } from "framer-motion";
import { toast } from "sonner";

import {
  JobsProvider,
  JobListContent,
  JobDetailPane,
} from "@/components/app/jobs-pane";
import { BranchSelect } from "@/components/app/branch-select";
import { PathInput } from "@/components/app/path-input";
import type { AgentType } from "@/lib/agent-types";
import { type Agent } from "@/components/app/types";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
import { useClickOutside } from "@/hooks/use-click-outside";
import { swallowEscapeFromCombobox } from "@/lib/dialog-escape";
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
        </div>
      </div>
      {activeTab === "templates" ? (
        <TemplateListContent
          enabledAgentTypes={enabledAgentTypes}
          onItemSelect={onItemSelect}
        />
      ) : (
        <JobListContent onItemSelect={onItemSelect} hideHeader />
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
  selected,
  onSelect,
}: {
  template: Template;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const { launchTemplate } = useTemplateActions();
  const [launchDialogOpen, setLaunchDialogOpen] = useState(false);
  const args = useMemo(
    () => (template.prompt ? parseTemplateArgs(template.prompt) : []),
    [template.prompt]
  );

  const handleLaunch = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (args.length > 0) {
        setLaunchDialogOpen(true);
        return;
      }
      launchTemplate
        .mutateAsync({ id: template.id })
        .then((result) => {
          navigate(agentRoute(result.agent.id));
        })
        .catch((err: Error) => {
          toast.error(`Failed to launch: ${err.message}`);
        });
    },
    [args.length, launchTemplate, navigate, template.id]
  );

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
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Template detail pane
// ---------------------------------------------------------------------------

export function TemplateDetailPane({
  enabledAgentTypes,
}: {
  enabledAgentTypes: AgentType[];
}): JSX.Element {
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

  return (
    <TemplateDetail template={template} enabledAgentTypes={enabledAgentTypes} />
  );
}

function TemplateDetail({
  template,
  enabledAgentTypes,
}: {
  template: Template;
  enabledAgentTypes: AgentType[];
}): JSX.Element {
  const navigate = useNavigate();
  const { updateTemplate, removeTemplate, launchTemplate } =
    useTemplateActions();

  // Editable form state — reset when template changes
  const [displayName, setDisplayName] = useState(template.name);
  const [description, setDescription] = useState(template.description ?? "");
  const [directory, setDirectory] = useState(template.directory);
  const [prompt, setPrompt] = useState(template.prompt ?? "");
  const [agentType, setAgentType] = useState<CliAgentType>(template.agentType);
  const [useWorktree, setUseWorktree] = useState(template.useWorktree);
  const [baseBranch, setBaseBranch] = useState(template.baseBranch ?? "main");
  const [branchName, setBranchName] = useState(template.branchName ?? "");
  const [fullAccess, setFullAccess] = useState(template.fullAccess);
  const [callable, setCallable] = useState(template.callable);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [launchDialogOpen, setLaunchDialogOpen] = useState(false);

  useEffect(() => {
    setDisplayName(template.name);
    setDescription(template.description ?? "");
    setDirectory(template.directory);
    setPrompt(template.prompt ?? "");
    setAgentType(template.agentType);
    setUseWorktree(template.useWorktree);
    setBaseBranch(template.baseBranch ?? "main");
    setBranchName(template.branchName ?? "");
    setFullAccess(template.fullAccess);
    setCallable(template.callable);
    setSaveError(null);
    setRemoveDialogOpen(false);
    setLaunchDialogOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template.id]);

  const detectedArgs = useMemo(
    () => (prompt ? parseTemplateArgs(prompt) : []),
    [prompt]
  );

  const savedArgs = useMemo(
    () => (template.prompt ? parseTemplateArgs(template.prompt) : []),
    [template.prompt]
  );

  const handleLaunch = useCallback(() => {
    if (savedArgs.length > 0) {
      setLaunchDialogOpen(true);
      return;
    }
    launchTemplate
      .mutateAsync({ id: template.id })
      .then((result) => {
        navigate(agentRoute(result.agent.id));
      })
      .catch((err: Error) => {
        toast.error(`Failed to launch: ${err.message}`);
      });
  }, [savedArgs.length, launchTemplate, template.id, navigate]);

  const canSave = !!displayName.trim() && !!directory.trim();

  const handleSave = useCallback(() => {
    setSaveError(null);
    updateTemplate
      .mutateAsync({
        id: template.id,
        name: displayName.trim(),
        description: description.trim() || null,
        directory: directory.trim(),
        prompt: prompt || null,
        agentType,
        useWorktree,
        baseBranch: useWorktree ? baseBranch : null,
        branchName: useWorktree ? branchName || null : null,
        fullAccess,
        callable,
      })
      .then(() => toast.success("Settings saved."))
      .catch((err: Error) => setSaveError(err.message));
  }, [
    updateTemplate,
    template.id,
    displayName,
    description,
    directory,
    prompt,
    agentType,
    useWorktree,
    baseBranch,
    branchName,
    fullAccess,
    callable,
  ]);

  const handleDelete = useCallback(() => {
    removeTemplate
      .mutateAsync(template.id)
      .then(() => {
        setRemoveDialogOpen(false);
        navigate("/automations");
        toast.success(`Template "${template.name}" deleted.`);
      })
      .catch((err: Error) => {
        setRemoveDialogOpen(false);
        toast.error(`Failed to delete: ${err.message}`);
      });
  }, [removeTemplate, template, navigate]);

  const cliAgentTypes = useMemo(
    () => enabledAgentTypes.filter(isCliAgentType),
    [enabledAgentTypes]
  );

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* Header with launch */}
      <div className="border-b border-border px-6 py-5">
        <h2 className="text-lg font-semibold text-foreground">
          {template.name}
        </h2>
        {template.description ? (
          <p className="mt-0.5 text-sm text-muted-foreground">
            {template.description}
          </p>
        ) : null}
        <p className="mt-0.5 text-xs text-muted-foreground/70">
          {shortPath(template.directory)}
        </p>

        {savedArgs.length > 0 ? (
          <div className="mt-3 rounded-md border border-border/60 bg-muted/15 px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              Required arguments:
            </span>{" "}
            {savedArgs.map((a, i) => (
              <span key={a.key}>
                {i > 0 ? ", " : ""}
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                  {a.name}
                </span>
              </span>
            ))}
          </div>
        ) : null}
        <Button
          className="mt-4 gap-1.5"
          disabled={launchTemplate.isPending}
          onClick={handleLaunch}
        >
          {launchTemplate.isPending ? (
            <ActivityBars size={16} className="mr-1" />
          ) : (
            <Play className="h-3.5 w-3.5 fill-current" />
          )}
          Launch
        </Button>
      </div>

      {/* Inline-editable config form */}
      <div className="flex-1 px-6 py-5">
        <div className="grid gap-4">
          <div className="rounded-md border border-white/[0.12] bg-white/[0.04] p-4">
            <div className="text-sm font-medium">Template configuration</div>
            <p className="mt-1 text-xs text-muted-foreground">
              Agent launch settings for this template.
            </p>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <div className="space-y-1 md:col-span-2">
                <label className="text-sm text-muted-foreground">
                  Agent type
                </label>
                <AgentTypeCombobox
                  value={agentType}
                  onChange={setAgentType}
                  agentTypes={cliAgentTypes}
                />
              </div>
              <div className="space-y-1 md:col-span-2">
                <label className="text-sm text-muted-foreground">Name</label>
                <Input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>
              <div className="space-y-1 md:col-span-2">
                <label className="text-sm text-muted-foreground">
                  Description
                </label>
                <Input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional short description"
                />
              </div>
              <div className="space-y-1 md:col-span-2">
                <label className="text-sm text-muted-foreground">
                  Working directory
                </label>
                <PathInput
                  value={directory}
                  onChange={setDirectory}
                  placeholder="/path/to/repo"
                />
              </div>
            </div>

            <div className="mt-4 grid gap-3">
              <TemplateWorktreeOption
                checked={useWorktree}
                cwd={directory}
                baseBranch={baseBranch}
                branchName={branchName}
                onCheckedChange={setUseWorktree}
                onBaseBranchChange={setBaseBranch}
                onBranchNameChange={setBranchName}
              />
              <TemplateFullAccessOption
                checked={fullAccess}
                onCheckedChange={setFullAccess}
              />
              <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
                <Checkbox
                  checked={callable}
                  onCheckedChange={() => setCallable((c) => !c)}
                  className="mt-0.5"
                />
                <span className="space-y-1">
                  <span className="block text-sm font-medium text-foreground">
                    Show in command palette
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Launch this template from the {"⌘"}K palette.
                  </span>
                </span>
              </label>
            </div>

            <div className="mt-4 space-y-1 md:col-span-2">
              <label className="text-sm text-muted-foreground">Prompt</label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe what the agent should do..."
                className={cn(
                  "flex min-h-[120px] w-full resize-y rounded-md border border-white/[0.12] bg-white/[0.04] px-3 py-2 text-sm shadow-[inset_0_2px_6px_rgba(0,0,0,0.3)] backdrop-blur-md",
                  "ring-offset-background placeholder:text-muted-foreground",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                )}
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

            {saveError ? (
              <div className="mt-4 rounded-md border border-status-blocked/40 bg-status-blocked/10 p-3 text-sm text-status-blocked">
                {saveError}
              </div>
            ) : null}
            <div className="mt-4 flex justify-end">
              <Button
                variant="primary"
                disabled={!canSave || updateTemplate.isPending}
                onClick={handleSave}
              >
                {updateTemplate.isPending ? (
                  <ActivityBars size={16} className="mr-2" />
                ) : null}
                Save
              </Button>
            </div>
          </div>

          <div className="rounded-md border border-status-blocked/30 bg-status-blocked/5 p-4">
            <div className="text-sm font-medium text-status-blocked">
              Delete template
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Permanently remove this template. Jobs that reference it will lose
              their backing template.
            </p>
            <div className="mt-3 flex justify-end">
              <Button
                variant="destructive"
                size="sm"
                disabled={removeTemplate.isPending}
                onClick={() => setRemoveDialogOpen(true)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </Button>
            </div>
          </div>
        </div>
      </div>

      <Dialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete template</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &ldquo;{template.name}&rdquo;?
              This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => setRemoveDialogOpen(false)}
              disabled={removeTemplate.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={removeTemplate.isPending}
            >
              {removeTemplate.isPending ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <LaunchTemplateDialog
        template={template}
        open={launchDialogOpen}
        onOpenChange={setLaunchDialogOpen}
      />
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
// Launch template dialog (modal with args + launch)
// ---------------------------------------------------------------------------

export function LaunchTemplateDialog({
  template,
  open,
  onOpenChange,
}: {
  template: Template;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const navigate = useNavigate();
  const { launchTemplate } = useTemplateActions();

  const args = useMemo(
    () => (template.prompt ? parseTemplateArgs(template.prompt) : []),
    [template.prompt]
  );
  const [argValues, setArgValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) setArgValues({});
  }, [open]);

  const allArgsFilled =
    args.length === 0 || args.every((a) => argValues[a.key]?.trim());

  const handleLaunch = useCallback(() => {
    const launchArgs = args.length > 0 ? argValues : undefined;
    launchTemplate
      .mutateAsync({ id: template.id, args: launchArgs })
      .then((result) => {
        onOpenChange(false);
        navigate(agentRoute(result.agent.id));
      })
      .catch((err: Error) => {
        toast.error(`Failed to launch: ${err.message}`);
      });
  }, [args, argValues, launchTemplate, navigate, onOpenChange, template.id]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{template.name}</DialogTitle>
          {template.description ? (
            <DialogDescription>{template.description}</DialogDescription>
          ) : (
            <DialogDescription>
              This will create a new agent from this template.
            </DialogDescription>
          )}
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (allArgsFilled && !launchTemplate.isPending) handleLaunch();
          }}
        >
          {args.length > 0 ? (
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
          ) : null}

          <div className="flex flex-row-reverse justify-start gap-2 pt-3">
            <Button
              type="submit"
              variant="primary"
              disabled={!allArgsFilled || launchTemplate.isPending}
            >
              {launchTemplate.isPending ? (
                <ActivityBars size={16} className="mr-1.5" />
              ) : (
                <Play className="h-3.5 w-3.5 mr-1.5 fill-current" />
              )}
              Launch
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Create template dialog (mirrors create-agent-dialog components)
// ---------------------------------------------------------------------------

function CreateTemplateDialog({
  open,
  onOpenChange,
  enabledAgentTypes,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enabledAgentTypes: AgentType[];
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <CreateTemplateDialogContent
          onOpenChange={onOpenChange}
          enabledAgentTypes={enabledAgentTypes}
        />
      ) : null}
    </Dialog>
  );
}

function CreateTemplateDialogContent({
  onOpenChange,
  enabledAgentTypes,
}: {
  onOpenChange: (open: boolean) => void;
  enabledAgentTypes: AgentType[];
}): JSX.Element {
  const { addTemplate } = useTemplateActions();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [directory, setDirectory] = useState("");
  const [prompt, setPrompt] = useState("");
  const [agentType, setAgentType] = useState<CliAgentType>("claude");
  const [useWorktree, setUseWorktree] = useState(false);
  const [baseBranch, setBaseBranch] = useState("main");
  const [branchName, setBranchName] = useState("");
  const [fullAccess, setFullAccess] = useState(false);
  const [callable, setCallable] = useState(true);
  const [creating, setCreating] = useState(false);

  const cliAgentTypes = useMemo(
    () => enabledAgentTypes.filter(isCliAgentType),
    [enabledAgentTypes]
  );

  const detectedArgs = useMemo(
    () => (prompt ? parseTemplateArgs(prompt) : []),
    [prompt]
  );

  const handleCreate = useCallback(() => {
    setCreating(true);
    addTemplate
      .mutateAsync({
        name,
        description: description.trim() || null,
        directory,
        prompt: prompt || null,
        agentType,
        useWorktree,
        baseBranch: useWorktree ? baseBranch : null,
        branchName: useWorktree ? branchName || null : null,
        fullAccess,
        callable,
      })
      .then(() => {
        onOpenChange(false);
        toast.success("Template created.");
      })
      .catch((err: Error) => {
        toast.error(`Failed to create template: ${err.message}`);
      })
      .finally(() => setCreating(false));
  }, [
    addTemplate,
    name,
    description,
    directory,
    prompt,
    agentType,
    useWorktree,
    baseBranch,
    branchName,
    fullAccess,
    callable,
    onOpenChange,
  ]);

  const canCreate = name.trim() && directory.trim();

  return (
    <DialogContent
      onEscapeKeyDown={(e) => {
        swallowEscapeFromCombobox(e);
      }}
    >
      <DialogHeader>
        <DialogTitle>Create Template</DialogTitle>
        <DialogDescription>
          A reusable agent launch configuration. Use{" "}
          <code className="rounded bg-white/[0.08] px-1 text-xs">
            {"{{D:Arg Name}}"}
          </code>{" "}
          in the prompt for runtime arguments.
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-1">
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-sm text-muted-foreground">Agent type</label>
            <AgentTypeCombobox
              value={agentType}
              onChange={setAgentType}
              agentTypes={cliAgentTypes}
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm text-muted-foreground">Name</label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="template name"
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm text-muted-foreground">Description</label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional short description"
            />
          </div>

          <PathInput
            value={directory}
            onChange={setDirectory}
            label="Working directory"
            placeholder="/path/to/repo"
          />

          <TemplateWorktreeOption
            checked={useWorktree}
            cwd={directory}
            baseBranch={baseBranch}
            branchName={branchName}
            onCheckedChange={setUseWorktree}
            onBaseBranchChange={setBaseBranch}
            onBranchNameChange={setBranchName}
          />

          <TemplateFullAccessOption
            checked={fullAccess}
            onCheckedChange={setFullAccess}
          />

          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
            <Checkbox
              checked={callable}
              onCheckedChange={() => setCallable((c) => !c)}
              className="mt-0.5"
            />
            <span className="space-y-1">
              <span className="block text-sm font-medium text-foreground">
                Show in command palette
              </span>
              <span className="block text-xs text-muted-foreground">
                Launch this template from the {"⌘"}K palette.
              </span>
            </span>
          </label>

          <div className="space-y-1">
            <label className="text-sm text-muted-foreground">Prompt</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe what the agent should do..."
              className={cn(
                "flex min-h-[120px] w-full resize-y rounded-md border border-white/[0.12] bg-white/[0.04] px-3 py-2 text-sm shadow-[inset_0_2px_6px_rgba(0,0,0,0.3)] backdrop-blur-md",
                "ring-offset-background placeholder:text-muted-foreground",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              )}
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
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-3">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleCreate}
          disabled={!canCreate || creating}
        >
          {creating ? <ActivityBars size={16} className="mr-1.5" /> : null}
          Create
        </Button>
      </div>
    </DialogContent>
  );
}

// ---------------------------------------------------------------------------
// Shared form components for create & edit
// ---------------------------------------------------------------------------

function AgentTypeCombobox({
  value,
  onChange,
  agentTypes,
}: {
  value: CliAgentType;
  onChange: (value: CliAgentType) => void;
  agentTypes: CliAgentType[];
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const cmdRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(cmdRef, open, close);

  return (
    <div className="relative" ref={cmdRef}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (!open) setOpen(true);
          }
        }}
        className={cn(
          "flex h-9 w-full items-center justify-between rounded-md border border-white/[0.12] bg-white/[0.04] px-3 py-2 text-sm shadow-[inset_0_2px_6px_rgba(0,0,0,0.3)] backdrop-blur-md",
          "ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring"
        )}
      >
        {AGENT_TYPE_LABELS[value]}
        <ChevronDown
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform",
            open && "rotate-180"
          )}
        />
      </button>
      {open ? (
        <div className="absolute left-0 right-0 z-[80] mt-1 rounded-md border border-white/[0.2] bg-[hsl(var(--card))] shadow-[0_16px_64px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-2xl">
          <Command
            shouldFilter={false}
            ref={(el) => {
              if (el) requestAnimationFrame(() => el.focus());
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
                requestAnimationFrame(() => triggerRef.current?.focus());
              }
            }}
          >
            <CommandList>
              <CommandGroup>
                {agentTypes.map((t) => (
                  <CommandItem
                    key={t}
                    value={t}
                    onSelect={() => {
                      onChange(t);
                      setOpen(false);
                      requestAnimationFrame(() => triggerRef.current?.focus());
                    }}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-3 w-3 shrink-0",
                        t === value ? "opacity-100" : "opacity-0"
                      )}
                    />
                    {AGENT_TYPE_LABELS[t]}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      ) : null}
    </div>
  );
}

function TemplateWorktreeOption({
  checked,
  cwd,
  baseBranch,
  branchName,
  onCheckedChange,
  onBaseBranchChange,
  onBranchNameChange,
}: {
  checked: boolean;
  cwd: string;
  baseBranch: string;
  branchName: string;
  onCheckedChange: (checked: boolean) => void;
  onBaseBranchChange: (value: string) => void;
  onBranchNameChange: (value: string) => void;
}): JSX.Element {
  return (
    <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
      <label className="flex cursor-pointer items-start gap-3">
        <Checkbox
          checked={checked}
          onCheckedChange={() => onCheckedChange(!checked)}
          className="mt-0.5"
          title="Toggle git worktree"
        />
        <span className="space-y-1">
          <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <GitBranch className="h-3.5 w-3.5" />
            Run in a git worktree
          </span>
          <span className="block text-xs text-muted-foreground">
            Creates an isolated worktree when this template is launched.
          </span>
        </span>
      </label>
      {checked ? (
        <div className="ml-8 w-[calc(100%-2rem)]">
          <BranchSelect
            cwd={cwd}
            baseBranch={baseBranch}
            onBaseBranchChange={onBaseBranchChange}
            worktreeBranch={branchName}
            onWorktreeBranchChange={onBranchNameChange}
            testIdPrefix="template-worktree"
          />
        </div>
      ) : null}
    </div>
  );
}

function TemplateFullAccessOption({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
      <Checkbox
        checked={checked}
        onCheckedChange={() => onCheckedChange(!checked)}
        className="mt-0.5"
        title="Toggle full access"
      />
      <span className="space-y-1">
        <span className="block text-sm font-medium text-foreground">
          Start in full access mode
        </span>
        <span className="block text-xs text-muted-foreground">
          Starts the selected agent with its most permissive supported execution
          mode.
        </span>
      </span>
    </label>
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
          enabledAgentTypes={enabledAgentTypes}
          onItemSelect={isMobile ? closeSidebar : undefined}
        />
      </JobsProvider>
    );
  }

  return (
    <AutomationsSidebar
      activeTab={activeTab}
      onTabChange={handleTabChange}
      enabledAgentTypes={enabledAgentTypes}
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
    return <TemplateDetailPane enabledAgentTypes={enabledAgentTypes} />;
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
