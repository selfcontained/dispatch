import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Play } from "lucide-react";
import { toast } from "sonner";

import { ArgInput } from "@/components/app/arg-input";
import { ContextPicker } from "@/components/app/context-picker";
import { AgentTypeSelect } from "@/components/app/agent-type-select";
import { AgentModelSelect } from "@/components/app/agent-model-select";
import { useStartupAttachments } from "@/components/app/use-startup-attachments";
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
  useTemplateActions,
  parseTemplateArgs,
  type Template,
} from "@/hooks/use-templates";
import { type AgentType } from "@/lib/agent-types";
import { useAgentModelCatalog } from "@/hooks/use-agent-model-catalog";
import { useRadixPopoverZFix } from "@/hooks/use-radix-popover-z-fix";
import { swallowEscapeFromCombobox } from "@/lib/dialog-escape";
import { agentRoute } from "@/lib/agent-routes";
import { cn } from "@/lib/utils";

export function LaunchTemplateDialog({
  template,
  open,
  onOpenChange,
  agentTypes,
}: {
  template: Template;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentTypes: AgentType[];
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
  agentTypes: AgentType[];
}): JSX.Element {
  const navigate = useNavigate();
  const { launchTemplate } = useTemplateActions();
  const launchButtonRef = useRef<HTMLButtonElement>(null);

  const args = useMemo(
    () => (template.prompt ? parseTemplateArgs(template.prompt) : []),
    [template.prompt]
  );
  const [argValues, setArgValues] = useState<Record<string, string>>({});
  const [agentType, setAgentType] = useState<AgentType>(template.agentType);
  const [model, setModel] = useState<string | null>(template.model);
  // Each runtime keeps its own pick for the dialog's lifetime, so toggling the
  // agent type to compare and back does not silently drop a chosen model.
  const modelByAgentType = useRef<Partial<Record<AgentType, string | null>>>({
    [template.agentType]: template.model,
  });
  const {
    options: modelOptions,
    loading: modelCatalogLoading,
    loaded: modelCatalogLoaded,
  } = useAgentModelCatalog(agentType);
  const showModelSelect = modelCatalogLoading || modelOptions.length > 0;

  const isTerminal = agentType === "terminal";
  const showMedia = !isTerminal && template.allowMedia;
  const {
    startupFiles,
    startupLinks,
    draggingFiles,
    setDraggingFiles,
    startupFilePreviewsRef,
    appendStartupFiles,
    handleAddLink,
    handleRemoveStartupFile,
    handleRemoveStartupLink,
    handleStartupDrop,
  } = useStartupAttachments();

  useEffect(() => {
    setArgValues({});
    setAgentType(template.agentType);
    setModel(template.model);
    modelByAgentType.current = { [template.agentType]: template.model };
  }, [template.agentType, template.model]);

  const handleAgentTypeChange = useCallback(
    (nextAgentType: AgentType) => {
      modelByAgentType.current[agentType] = model;
      setAgentType(nextAgentType);
      setModel(modelByAgentType.current[nextAgentType] ?? null);
    },
    [agentType, model]
  );

  const handleModelChange = useCallback(
    (nextModel: string | null) => {
      modelByAgentType.current[agentType] = nextModel;
      setModel(nextModel);
    },
    [agentType]
  );

  useEffect(() => {
    if (args.length > 0) return;
    requestAnimationFrame(() => launchButtonRef.current?.focus());
  }, [args.length]);

  useRadixPopoverZFix();

  const allArgsFilled =
    args.length === 0 ||
    args.every((a) => !a.required || argValues[a.key]?.trim());

  const handleLaunch = useCallback(() => {
    const launchArgs = args.length > 0 ? argValues : undefined;
    // Terminal sessions have no model. Otherwise: until the catalog arrives we
    // cannot tell a valid selection from a retired model id, so send nothing
    // and let the template's saved model stand.
    const launchModel =
      isTerminal || !modelCatalogLoaded
        ? undefined
        : modelOptions.some((option) => option.id === model)
          ? model
          : null;
    launchTemplate
      .mutateAsync({
        id: template.id,
        args: launchArgs,
        agentType,
        model: launchModel,
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
    isTerminal,
    launchTemplate,
    model,
    modelCatalogLoaded,
    modelOptions,
    navigate,
    onOpenChange,
    startupFiles,
    startupLinks,
    template.id,
  ]);

  return (
    <DialogContent
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
            {isTerminal
              ? `This will open a terminal session in ${template.directory}.`
              : "This will create a new agent from this template."}
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
        onDrop={showMedia ? handleStartupDrop : undefined}
      >
        {!isTerminal ? (
          <div
            className={cn(
              "grid gap-3",
              showModelSelect && "min-[420px]:grid-cols-2"
            )}
          >
            <AgentTypeSelect
              label="Agent type"
              id="launch-template-agent-type"
              value={agentType}
              onChange={handleAgentTypeChange}
              agentTypes={agentTypes}
            />
            {showModelSelect ? (
              <AgentModelSelect
                value={model}
                options={modelOptions}
                onChange={handleModelChange}
                loading={modelCatalogLoading}
                id="launch-template-model"
                testId="launch-template-model"
              />
            ) : null}
          </div>
        ) : null}

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
          <ContextPicker
            className="mt-3"
            files={startupFiles}
            links={startupLinks}
            draggingFiles={draggingFiles}
            filePreviewsRef={startupFilePreviewsRef}
            onAppendFiles={appendStartupFiles}
            onRemoveFile={handleRemoveStartupFile}
            onAddLink={handleAddLink}
            onRemoveLink={handleRemoveStartupLink}
          />
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
