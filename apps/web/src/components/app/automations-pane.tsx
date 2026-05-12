import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  AlarmClock,
  Check,
  ChevronDown,
  ChevronLeft,
  Clipboard,
  FileText,
  FormInput,
  GitBranch,
  Link2,
  Paperclip,
  Play,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { motion } from "framer-motion";
import { toast } from "sonner";

import {
  JobsProvider,
  JobListContent,
  JobDetailPane,
} from "@/components/app/jobs-pane";
import { BranchSelect } from "@/components/app/branch-select";
import {
  type ClipboardSuggestion,
  createClipboardSuggestionFromText,
  getClipboardFilesFromEvent,
  getClipboardSuggestion,
  isLikelyUrl,
  normalizeUrl,
} from "@/components/app/create-agent-dialog-clipboard";
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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

const STARTUP_FILE_ACCEPT =
  ".png,.jpg,.jpeg,.gif,.webp,.mp4,.pdf,.txt,.md,.json,.yaml,.yml,.toml,.csv,.log,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.go,.rs,.sh,.sql,.diff,.patch,.env,.ini,.cfg,.conf,.swift,.kt,.java,.c,.cpp,.h,.hpp,.rb,.php,.lua,.zig,.nim,.r,.m,.ex,.exs,.erl,.hs";

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
  const cliAgentTypes = useMemo(
    () => enabledAgentTypes.filter(isCliAgentType),
    [enabledAgentTypes]
  );

  const needsDialog = args.length > 0 || template.allowMedia;

  const handleLaunch = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (needsDialog) {
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
    [needsDialog, launchTemplate, navigate, template.id]
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
        agentTypes={cliAgentTypes}
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
  const [allowMedia, setAllowMedia] = useState(template.allowMedia);
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
    setAllowMedia(template.allowMedia);
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

  const detailNeedsDialog = savedArgs.length > 0 || template.allowMedia;

  const handleLaunch = useCallback(() => {
    if (detailNeedsDialog) {
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
  }, [detailNeedsDialog, launchTemplate, template.id, navigate]);

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
        allowMedia,
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
    allowMedia,
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
              <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
                <Checkbox
                  checked={allowMedia}
                  onCheckedChange={() => setAllowMedia((c) => !c)}
                  className="mt-0.5"
                />
                <span className="space-y-1">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                    <Paperclip className="h-3.5 w-3.5" />
                    Allow media attachments on launch
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Show a context area for files and links when launching this
                    template.
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
        agentTypes={cliAgentTypes}
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
    <div className="space-y-2">
      <label className="text-sm text-muted-foreground">{arg.name}</label>
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
// File/link helpers (shared with create-agent-dialog)
// ---------------------------------------------------------------------------

function startupFileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function startupFileExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1
    ? "FILE"
    : name
        .slice(dot + 1)
        .toUpperCase()
        .slice(0, 4);
}

function startupLinkLabel(url: string): { host: string; rest: string } {
  try {
    const u = new URL(url);
    const rest =
      (u.pathname === "/" ? "" : u.pathname) +
      (u.search || "") +
      (u.hash || "");
    return { host: u.hostname.replace(/^www\./, ""), rest };
  } catch {
    return { host: url, rest: "" };
  }
}

const CONTEXT_LINK_INPUT_ID = "launch-template-context-link-input";
const CONTEXT_LINK_ERROR_ID = "launch-template-context-link-error";

function LaunchAddContextMenu({
  onAddFile,
  onAddLink,
}: {
  onAddFile: () => void;
  onAddLink: () => void;
}) {
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onAddFile}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-foreground hover:bg-white/[0.1]"
      >
        <Upload className="h-3.5 w-3.5 text-muted-foreground" />
        Add file
      </button>
      <button
        type="button"
        onClick={onAddLink}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-foreground hover:bg-white/[0.1]"
      >
        <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
        Add link
      </button>
    </div>
  );
}

function LaunchAddContextLinkForm({
  value,
  onChange,
  onSubmit,
  onBack,
  isValid,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onBack: () => void;
  isValid: boolean;
}) {
  return (
    <div className="space-y-1.5 p-1">
      <label
        htmlFor={CONTEXT_LINK_INPUT_ID}
        className="text-xs text-muted-foreground"
      >
        Link URL
      </label>
      <Input
        id={CONTEXT_LINK_INPUT_ID}
        autoFocus
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (value.trim().length > 0 && isValid) {
              onSubmit();
            }
          }
        }}
        placeholder="https://..."
        aria-invalid={!isValid}
        aria-describedby={!isValid ? CONTEXT_LINK_ERROR_ID : undefined}
      />
      {!isValid ? (
        <p id={CONTEXT_LINK_ERROR_ID} className="text-xs text-status-blocked">
          Enter a valid `http:` or `https:` URL.
        </p>
      ) : null}
      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeft className="mr-1 h-3 w-3" />
          Back
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={onSubmit}
          disabled={value.trim().length === 0 || !isValid}
        >
          Add link
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Launch template dialog (modal with args + context/files)
// ---------------------------------------------------------------------------

export function LaunchTemplateDialog({
  template,
  open,
  onOpenChange,
  agentTypes,
}: {
  template: Template;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentTypes: CliAgentType[];
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <LaunchTemplateDialogContent
          template={template}
          onOpenChange={onOpenChange}
          agentTypes={agentTypes}
        />
      ) : null}
    </Dialog>
  );
}

function LaunchTemplateDialogContent({
  template,
  onOpenChange,
  agentTypes,
}: {
  template: Template;
  onOpenChange: (open: boolean) => void;
  agentTypes: CliAgentType[];
}): JSX.Element {
  const navigate = useNavigate();
  const { launchTemplate } = useTemplateActions();
  const launchButtonRef = useRef<HTMLButtonElement>(null);

  const args = useMemo(
    () => (template.prompt ? parseTemplateArgs(template.prompt) : []),
    [template.prompt]
  );
  const [argValues, setArgValues] = useState<Record<string, string>>({});
  const [agentType, setAgentType] = useState<CliAgentType>(template.agentType);

  // Context / files state
  const showMedia = template.allowMedia;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const clipboardRequestIdRef = useRef(0);
  const [startupFiles, setStartupFiles] = useState<File[]>([]);
  const [startupLinks, setStartupLinks] = useState<string[]>([]);
  const [linkDraft, setLinkDraft] = useState("");
  const [checkingClipboard, setCheckingClipboard] = useState(false);
  const [clipboardPasteMode, setClipboardPasteMode] = useState(false);
  const [pasteTooltip, setPasteTooltip] = useState<string | null>(null);
  const clipboardPasteRef = useRef<HTMLInputElement>(null);
  const [clipboardReadFeedback, setClipboardReadFeedback] = useState<
    string | null
  >(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addMode, setAddMode] = useState<"menu" | "link">("menu");

  const startupFilePreviewsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (!open) return;
    setArgValues({});
    setAgentType(template.agentType);
  }, [open, template.agentType]);

  useEffect(() => {
    if (!open || args.length > 0) return;
    requestAnimationFrame(() => launchButtonRef.current?.focus());
  }, [args.length, open]);

  useEffect(() => {
    const previews = startupFilePreviewsRef.current;
    return () => {
      for (const url of previews.values()) {
        URL.revokeObjectURL(url);
      }
      previews.clear();
    };
  }, []);

  // Radix Popover z-index fix — same as create-agent-dialog
  useEffect(() => {
    const style = document.createElement("style");
    style.textContent =
      "[data-radix-popper-content-wrapper]{z-index:80!important}";
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, []);

  const appendStartupFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setStartupFiles((current) => {
      const next = [...current];
      const seen = new Set(current.map(startupFileKey));
      for (const file of files) {
        const key = startupFileKey(file);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(file);
        if (
          file.type.startsWith("image/") &&
          !startupFilePreviewsRef.current.has(key)
        ) {
          startupFilePreviewsRef.current.set(key, URL.createObjectURL(file));
        }
      }
      return next;
    });
  }, []);

  const applyClipboardSuggestion = useCallback(
    (suggestion: ClipboardSuggestion) => {
      switch (suggestion.kind) {
        case "image":
        case "file":
          appendStartupFiles([suggestion.file]);
          break;
        case "url":
          setStartupLinks((current) =>
            current.includes(suggestion.url)
              ? current
              : [...current, suggestion.url]
          );
          break;
        case "text":
          break;
      }
    },
    [appendStartupFiles]
  );

  const handleCheckClipboard = useCallback(() => {
    setCheckingClipboard(true);
    setClipboardReadFeedback(null);
    const requestId = clipboardRequestIdRef.current + 1;
    clipboardRequestIdRef.current = requestId;
    void getClipboardSuggestion().then((result) => {
      if (clipboardRequestIdRef.current !== requestId) return;
      setCheckingClipboard(false);
      if (result.suggestion) {
        applyClipboardSuggestion(result.suggestion);
        return;
      }
      if (result.status === "blocked" || result.status === "unsupported") {
        setClipboardPasteMode(true);
        requestAnimationFrame(() => clipboardPasteRef.current?.focus());
      } else {
        setClipboardReadFeedback("Nothing readable found on the clipboard.");
      }
    });
  }, [applyClipboardSuggestion]);

  const handleClipboardPasteInput = useCallback(
    (event: ClipboardEvent<HTMLInputElement>) => {
      event.preventDefault();
      const pastedFiles = getClipboardFilesFromEvent(event);
      if (pastedFiles.length > 0) {
        appendStartupFiles(pastedFiles);
        setClipboardPasteMode(false);
        return;
      }
      const textSuggestion = createClipboardSuggestionFromText(
        event.clipboardData.getData("text/plain")
      );
      if (textSuggestion?.kind === "url") {
        applyClipboardSuggestion(textSuggestion);
        setClipboardPasteMode(false);
        return;
      }
      setPasteTooltip("No files or images found");
      setTimeout(() => setPasteTooltip(null), 2500);
    },
    [appendStartupFiles, applyClipboardSuggestion]
  );

  const handleClipboardPasteBlur = useCallback(() => {
    setClipboardPasteMode(false);
    setPasteTooltip(null);
  }, []);

  const handleRemoveStartupFile = useCallback((fileToRemove: File) => {
    const key = startupFileKey(fileToRemove);
    const url = startupFilePreviewsRef.current.get(key);
    if (url) {
      URL.revokeObjectURL(url);
      startupFilePreviewsRef.current.delete(key);
    }
    setStartupFiles((current) =>
      current.filter((file) => startupFileKey(file) !== key)
    );
  }, []);

  const handleRemoveStartupLink = useCallback((linkToRemove: string) => {
    setStartupLinks((current) =>
      current.filter((link) => link !== linkToRemove)
    );
  }, []);

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const selected = Array.from(event.target.files ?? []);
      appendStartupFiles(selected);
      event.target.value = "";
    },
    [appendStartupFiles]
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      const droppedFiles = Array.from(event.dataTransfer.files ?? []);
      if (droppedFiles.length === 0) return;
      event.preventDefault();
      setDraggingFiles(false);
      appendStartupFiles(droppedFiles);
    },
    [appendStartupFiles]
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      const pastedFiles = getClipboardFilesFromEvent(event);
      if (pastedFiles.length > 0) {
        event.preventDefault();
        appendStartupFiles(pastedFiles);
        setClipboardReadFeedback(null);
        return;
      }

      const textSuggestion = createClipboardSuggestionFromText(
        event.clipboardData.getData("text/plain")
      );
      if (textSuggestion?.kind === "url") {
        event.preventDefault();
        applyClipboardSuggestion(textSuggestion);
        setClipboardReadFeedback(null);
      }
    },
    [appendStartupFiles, applyClipboardSuggestion]
  );

  const handleAddOpenChange = useCallback((next: boolean) => {
    setAddOpen(next);
    if (!next) {
      setAddMode("menu");
      setLinkDraft("");
    }
  }, []);

  const handleAddFileFromMenu = useCallback(() => {
    setAddOpen(false);
    setAddMode("menu");
    requestAnimationFrame(() => fileInputRef.current?.click());
  }, []);

  const handleAddLinkFromMenu = useCallback(() => {
    setAddMode("link");
  }, []);

  const handleAddLinkBack = useCallback(() => {
    setLinkDraft("");
    setAddMode("menu");
  }, []);

  const trimmedLinkDraft = linkDraft.trim();
  const linkDraftIsValid =
    trimmedLinkDraft.length === 0 || isLikelyUrl(trimmedLinkDraft);

  const addStartupLink = useCallback(() => {
    const normalized = normalizeUrl(linkDraft);
    if (!normalized) return false;
    setStartupLinks((current) =>
      current.includes(normalized) ? current : [...current, normalized]
    );
    setLinkDraft("");
    return true;
  }, [linkDraft]);

  const handleAddLinkSubmit = useCallback(() => {
    if (!addStartupLink()) return;
    setAddMode("menu");
    setAddOpen(false);
  }, [addStartupLink]);

  const allArgsFilled =
    args.length === 0 || args.every((a) => argValues[a.key]?.trim());

  const handleLaunch = useCallback(() => {
    const launchArgs = args.length > 0 ? argValues : undefined;
    launchTemplate
      .mutateAsync({
        id: template.id,
        args: launchArgs,
        agentType,
        startupFiles: startupFiles.length > 0 ? startupFiles : undefined,
        startupLinks: startupLinks.length > 0 ? startupLinks : undefined,
      })
      .then((result) => {
        onOpenChange(false);
        navigate(agentRoute(result.agent.id));
      })
      .catch((err: Error) => {
        toast.error(`Failed to launch: ${err.message}`);
      });
  }, [
    agentType,
    args,
    argValues,
    launchTemplate,
    navigate,
    onOpenChange,
    startupFiles,
    startupLinks,
    template.id,
  ]);

  const hasContextItems = startupFiles.length > 0 || startupLinks.length > 0;

  return (
    <DialogContent
      className="max-w-md"
      onEscapeKeyDown={(e) => {
        swallowEscapeFromCombobox(e);
      }}
    >
      <DialogHeader className="space-y-2">
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
          onDragOver={
            showMedia
              ? (event) => {
                  if (event.dataTransfer.types.includes("Files")) {
                    event.preventDefault();
                    setDraggingFiles(true);
                  }
                }
              : undefined
          }
          onDragLeave={
            showMedia
              ? (event) => {
                  if (
                    event.currentTarget.contains(
                      event.relatedTarget as Node | null
                    )
                  ) {
                    return;
                  }
                  setDraggingFiles(false);
                }
              : undefined
          }
          onDrop={showMedia ? handleDrop : undefined}
        >
          <div className="space-y-2">
            <label className="text-sm text-muted-foreground">Agent type</label>
            <AgentTypeCombobox
              value={agentType}
              onChange={setAgentType}
              agentTypes={agentTypes}
            />
          </div>

          {args.length > 0 ? (
            <div className="mt-3 flex flex-col gap-3">
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

        {showMedia ? (
          <div
            className={cn(
              "mt-3 space-y-3 rounded-md border bg-muted/20 px-3 py-3 transition-colors",
              draggingFiles
                ? "border-status-done/35 bg-status-done/8 ring-1 ring-inset ring-status-done/30"
                : "border-border/70"
            )}
            onPaste={handlePaste}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <Paperclip className="h-3.5 w-3.5" />
                  Context
                </div>
                <p className="text-xs text-muted-foreground">
                  Attach files or links.
                </p>
              </div>
              {clipboardPasteMode ? (
                <div className="relative shrink-0">
                  <input
                    ref={clipboardPasteRef}
                    type="text"
                    placeholder="Paste here"
                    className="h-7 w-32 rounded-md border border-border/70 bg-background/40 px-2 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    onPaste={handleClipboardPasteInput}
                    onBlur={handleClipboardPasteBlur}
                  />
                  {pasteTooltip ? (
                    <div
                      className="absolute right-0 top-full z-50 mt-1.5 whitespace-nowrap rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
                      role="status"
                    >
                      {pasteTooltip}
                    </div>
                  ) : null}
                </div>
              ) : (
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  className="h-7 shrink-0 gap-1 px-2 text-xs"
                  onClick={handleCheckClipboard}
                  disabled={checkingClipboard}
                >
                  {checkingClipboard ? (
                    <ActivityBars size={12} className="mr-0.5" />
                  ) : (
                    <Clipboard className="h-3 w-3" />
                  )}
                  Read clipboard
                </Button>
              )}
            </div>
            {clipboardReadFeedback ? (
              <p
                className="text-xs text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                {clipboardReadFeedback}
              </p>
            ) : null}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={STARTUP_FILE_ACCEPT}
              className="hidden"
              onChange={handleFileChange}
            />
            {!hasContextItems ? (
              <Popover open={addOpen} onOpenChange={handleAddOpenChange}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      "flex w-full flex-col items-center justify-center gap-1.5 rounded-md border border-dashed px-4 py-6 text-sm transition-colors",
                      draggingFiles
                        ? "border-status-done bg-status-done/10 text-foreground"
                        : "border-border/70 bg-background/40 text-muted-foreground hover:border-border hover:bg-background/70 hover:text-foreground"
                    )}
                  >
                    {draggingFiles ? (
                      <>
                        <Upload className="h-5 w-5" />
                        <span>Drop file to add</span>
                      </>
                    ) : (
                      <>
                        <Plus className="h-5 w-5" />
                        <span>Add files or links</span>
                        <span className="text-[11px] text-muted-foreground/80">
                          Click to add, or drop a file here
                        </span>
                      </>
                    )}
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 p-1" forceMount>
                  {addMode === "menu" ? (
                    <LaunchAddContextMenu
                      onAddFile={handleAddFileFromMenu}
                      onAddLink={handleAddLinkFromMenu}
                    />
                  ) : (
                    <LaunchAddContextLinkForm
                      value={linkDraft}
                      onChange={setLinkDraft}
                      onSubmit={handleAddLinkSubmit}
                      onBack={handleAddLinkBack}
                      isValid={linkDraftIsValid}
                    />
                  )}
                </PopoverContent>
              </Popover>
            ) : (
              <div className="flex flex-wrap items-start gap-3">
                {startupFiles.map((file) => {
                  const key = startupFileKey(file);
                  const preview = startupFilePreviewsRef.current.get(key);
                  return (
                    <div key={key} className="group flex w-12 flex-col gap-0.5">
                      <div className="relative h-12 w-12 overflow-hidden rounded-md border border-border/70 bg-muted/40">
                        {preview ? (
                          <img
                            src={preview}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full flex-col items-center justify-center text-muted-foreground">
                            <FileText className="h-3.5 w-3.5" />
                            <span className="text-[8px] font-medium tracking-wide">
                              {startupFileExt(file.name)}
                            </span>
                          </div>
                        )}
                        <button
                          type="button"
                          className="absolute -right-2 -top-2 flex h-10 w-10 items-start justify-end rounded-full p-2 text-muted-foreground transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                          onClick={() => handleRemoveStartupFile(file)}
                          aria-label={`Remove ${file.name}`}
                        >
                          <span className="rounded-full border border-border/70 bg-background p-0.5">
                            <X className="h-2.5 w-2.5" />
                          </span>
                        </button>
                      </div>
                      <span
                        className="w-full truncate text-[8px] leading-tight text-muted-foreground"
                        title={file.name}
                      >
                        {file.name}
                      </span>
                    </div>
                  );
                })}
                {startupLinks.map((link) => {
                  const { host, rest } = startupLinkLabel(link);
                  return (
                    <div
                      key={link}
                      className="group relative flex h-12 max-w-[180px] flex-col justify-center gap-0.5 rounded-md border border-border/70 bg-muted/40 px-2 pr-7 leading-tight"
                      title={link}
                    >
                      <div className="flex items-center gap-1 text-[10px] text-foreground">
                        <Link2 className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                        <span className="truncate font-medium">{host}</span>
                      </div>
                      {rest ? (
                        <span className="truncate text-[9px] text-muted-foreground">
                          {rest}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className="absolute -right-2 -top-2 flex h-10 w-10 items-start justify-end rounded-full p-2 text-muted-foreground transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                        onClick={() => handleRemoveStartupLink(link)}
                        aria-label={`Remove ${link}`}
                      >
                        <span className="rounded-full border border-border/70 bg-background p-0.5">
                          <X className="h-2.5 w-2.5" />
                        </span>
                      </button>
                    </div>
                  );
                })}
                <Popover open={addOpen} onOpenChange={handleAddOpenChange}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      aria-label="Add context"
                      className={cn(
                        "flex h-12 w-12 items-center justify-center rounded-md border border-dashed transition-colors",
                        draggingFiles
                          ? "border-status-done bg-status-done/10 text-foreground"
                          : "border-border/70 bg-background/40 text-muted-foreground hover:border-border hover:bg-background/70 hover:text-foreground"
                      )}
                    >
                      {draggingFiles ? (
                        <Upload className="h-4 w-4" />
                      ) : (
                        <Plus className="h-4 w-4" />
                      )}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-72 p-1" forceMount>
                    {addMode === "menu" ? (
                      <LaunchAddContextMenu
                        onAddFile={handleAddFileFromMenu}
                        onAddLink={handleAddLinkFromMenu}
                      />
                    ) : (
                      <LaunchAddContextLinkForm
                        value={linkDraft}
                        onChange={setLinkDraft}
                        onSubmit={handleAddLinkSubmit}
                        onBack={handleAddLinkBack}
                        isValid={linkDraftIsValid}
                      />
                    )}
                  </PopoverContent>
                </Popover>
              </div>
            )}
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
  const [allowMedia, setAllowMedia] = useState(true);
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
        allowMedia,
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
    allowMedia,
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

          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
            <Checkbox
              checked={allowMedia}
              onCheckedChange={() => setAllowMedia((c) => !c)}
              className="mt-0.5"
            />
            <span className="space-y-1">
              <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                <Paperclip className="h-3.5 w-3.5" />
                Allow media attachments on launch
              </span>
              <span className="block text-xs text-muted-foreground">
                Show a context area for files and links when launching this
                template.
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
