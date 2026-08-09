import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Play, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { TemplateConfigFields } from "@/components/app/automations-form-fields";
import { LaunchTemplateDialog } from "@/components/app/automations-launch-dialog";
import { useCwdHistory } from "@/components/app/create-agent-dialog-utils";
import type { AgentType } from "@/lib/agent-types";
import { shortPath } from "@/lib/format";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useTemplates,
  useTemplateActions,
  parseTemplateArgs,
  type Template,
} from "@/hooks/use-templates";

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
  const { add: addCwdHistory } = useCwdHistory();

  const [displayName, setDisplayName] = useState(template.name);
  const [description, setDescription] = useState(template.description ?? "");
  const [directory, setDirectory] = useState(template.directory);
  const [prompt, setPrompt] = useState(template.prompt ?? "");
  const [agentType, setAgentType] = useState<AgentType>(template.agentType);
  const [model, setModel] = useState<string | null>(template.model);
  const [useWorktree, setUseWorktree] = useState(template.useWorktree);
  const [baseBranch, setBaseBranch] = useState(template.baseBranch ?? "main");
  const [branchName, setBranchName] = useState(template.branchName ?? "");
  const [fullAccess, setFullAccess] = useState(template.fullAccess);
  const [callable, setCallable] = useState(template.callable);
  const [allowMedia, setAllowMedia] = useState(template.allowMedia);
  const [selfImprove, setSelfImprove] = useState(template.selfImprove);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [launchDialogOpen, setLaunchDialogOpen] = useState(false);

  useEffect(() => {
    setDisplayName(template.name);
    setDescription(template.description ?? "");
    setDirectory(template.directory);
    setPrompt(template.prompt ?? "");
    setAgentType(template.agentType);
    setModel(template.model);
    setUseWorktree(template.useWorktree);
    setBaseBranch(template.baseBranch ?? "main");
    setBranchName(template.branchName ?? "");
    setFullAccess(template.fullAccess);
    setCallable(template.callable);
    setAllowMedia(template.allowMedia);
    setSelfImprove(template.selfImprove);
    setSaveError(null);
    setRemoveDialogOpen(false);
    setLaunchDialogOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template.id]);

  const savedArgs = useMemo(
    () => (template.prompt ? parseTemplateArgs(template.prompt) : []),
    [template.prompt]
  );

  const handleLaunch = useCallback(() => {
    setLaunchDialogOpen(true);
  }, []);

  const canSave = !!displayName.trim() && !!directory.trim();

  const handleSave = useCallback(() => {
    const isTerminal = agentType === "terminal";
    setSaveError(null);
    updateTemplate
      .mutateAsync({
        id: template.id,
        name: displayName.trim(),
        description: description.trim() || null,
        directory: directory.trim(),
        prompt: isTerminal ? null : prompt || null,
        agentType,
        model,
        useWorktree: isTerminal ? false : useWorktree,
        baseBranch: isTerminal ? null : useWorktree ? baseBranch : null,
        branchName: isTerminal ? null : useWorktree ? branchName || null : null,
        fullAccess: isTerminal ? false : fullAccess,
        callable,
        allowMedia: isTerminal ? false : allowMedia,
        selfImprove: isTerminal ? false : selfImprove,
      })
      .then(() => {
        addCwdHistory(directory);
        toast.success("Settings saved.");
      })
      .catch((err: Error) => setSaveError(err.message));
  }, [
    updateTemplate,
    template.id,
    displayName,
    description,
    directory,
    prompt,
    agentType,
    model,
    useWorktree,
    baseBranch,
    branchName,
    fullAccess,
    callable,
    allowMedia,
    selfImprove,
    addCwdHistory,
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
              Launch arguments:
            </span>{" "}
            {savedArgs.map((a, i) => (
              <span key={a.key}>
                {i > 0 ? ", " : ""}
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                  {a.name}
                  {a.required ? " *" : ""}
                  {a.multiline ? " (multiline)" : ""}
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
            <div className="mt-4">
              <TemplateConfigFields
                agentType={agentType}
                onAgentTypeChange={setAgentType}
                model={model}
                onModelChange={setModel}
                enabledAgentTypes={enabledAgentTypes}
                name={displayName}
                onNameChange={setDisplayName}
                description={description}
                onDescriptionChange={setDescription}
                directory={directory}
                onDirectoryChange={setDirectory}
                useWorktree={useWorktree}
                onUseWorktreeChange={setUseWorktree}
                baseBranch={baseBranch}
                onBaseBranchChange={setBaseBranch}
                branchName={branchName}
                onBranchNameChange={setBranchName}
                fullAccess={fullAccess}
                onFullAccessChange={setFullAccess}
                callable={callable}
                onCallableChange={setCallable}
                allowMedia={allowMedia}
                onAllowMediaChange={setAllowMedia}
                selfImprove={selfImprove}
                onSelfImproveChange={setSelfImprove}
                prompt={prompt}
                onPromptChange={setPrompt}
              />
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
        agentTypes={enabledAgentTypes}
      />
    </div>
  );
}
