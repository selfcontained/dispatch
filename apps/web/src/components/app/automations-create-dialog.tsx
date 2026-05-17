import { useCallback, useMemo, useState } from "react";
import { Paperclip } from "lucide-react";
import { toast } from "sonner";

import {
  AgentTypeCombobox,
  TemplateWorktreeOption,
  TemplateFullAccessOption,
} from "@/components/app/automations-form-fields";
import { PathInput } from "@/components/app/path-input";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useTemplateActions, parseTemplateArgs } from "@/hooks/use-templates";
import type { AgentType } from "@/lib/agent-types";
import { type CliAgentType, isCliAgentType } from "@/lib/agent-types";
import { swallowEscapeFromCombobox } from "@/lib/dialog-escape";
import { cn } from "@/lib/utils";

export function CreateTemplateDialog({
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
