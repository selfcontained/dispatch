import { AgentConfigRow } from "./agent-config-row";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Play } from "lucide-react";

import { ArgInput } from "@/components/app/arg-input";
import { ContextPicker } from "@/components/app/context-picker";
import { AgentTypeSelect } from "@/components/app/agent-type-select";
import type { Effort } from "@dispatch/shared";
import { AgentEffortSelect } from "./agent-effort-select";
import { AgentModelSelect } from "@/components/app/agent-model-select";
import { useStartupAttachments } from "@/components/app/use-startup-attachments";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useTemplateActions,
  parseTemplateArgs,
  templateArgDefaults,
  type Template,
} from "@/hooks/use-templates";
import { type AgentType } from "@/lib/agent-types";
import {
  useAgentModelCatalog,
  useAgentEffortChoices,
} from "@/hooks/use-agent-model-catalog";
import { agentRoute } from "@/lib/agent-routes";
import { effortCompatibilityError } from "@/lib/agent-effort";
import { Alert } from "@/components/ui/alert";
import { FieldError } from "@/components/ui/field";

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
  const [failure, setFailure] = useState<unknown>();

  const args = useMemo(
    () => (template.prompt ? parseTemplateArgs(template.prompt) : []),
    [template.prompt]
  );
  const [argValues, setArgValues] = useState<Record<string, string>>(() =>
    templateArgDefaults(args)
  );
  const [agentType, setAgentType] = useState<AgentType>(template.agentType);
  const [effort, setEffort] = useState<Effort | null>(template.effort ?? null);
  const [model, setModel] = useState<string | null>(template.model);
  // Each runtime keeps its own pick for the dialog's lifetime, so toggling the
  // agent type to compare and back does not silently drop a chosen model.
  const modelByAgentType = useRef<Partial<Record<AgentType, string | null>>>({
    [template.agentType]: template.model,
  });
  const {
    options: modelOptions,
    savedOption,
    loading: modelCatalogLoading,
    loaded: modelCatalogLoaded,
  } = useAgentModelCatalog(agentType);
  const showModelSelect = modelCatalogLoading || modelOptions.length > 0;

  const showFiles = template.allowFiles;
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
    setArgValues(templateArgDefaults(args));
    setAgentType(template.agentType);
    setEffort(template.effort ?? null);
    setModel(template.model);
    modelByAgentType.current = { [template.agentType]: template.model };
  }, [template.agentType, template.model, template.effort, args]);

  const handleAgentTypeChange = useCallback(
    (nextAgentType: AgentType) => {
      modelByAgentType.current[agentType] = model;
      setAgentType(nextAgentType);
      setEffort(null);
      setModel(modelByAgentType.current[nextAgentType] ?? null);
    },
    [agentType, model]
  );

  const handleModelChange = useCallback(
    (nextModel: string | null) => {
      modelByAgentType.current[agentType] = nextModel;
      setModel(nextModel);
      setEffort(null);
    },
    [agentType]
  );

  useEffect(() => {
    if (args.length > 0) return;
    requestAnimationFrame(() => launchButtonRef.current?.focus());
  }, [args.length]);

  const allArgsFilled =
    args.length === 0 ||
    args.every((a) => !a.error && (!a.required || argValues[a.key]?.trim()));

  const effortChoices = useAgentEffortChoices(agentType, model);
  const effortError = effortCompatibilityError(effort, effortChoices);

  const handleLaunch = useCallback(() => {
    if (effortError) return;
    setFailure(undefined);
    const launchArgs = args.length > 0 ? argValues : undefined;
    // Until the catalog arrives we cannot tell a valid selection from a
    // retired model id, so send nothing and let the template's saved model
    // stand.
    const launchModel = !modelCatalogLoaded
      ? undefined
      : savedOption(model)
        ? model
        : null;
    launchTemplate
      .mutateAsync({
        id: template.id,
        args: launchArgs,
        agentType,
        model: launchModel,
        effort,
        startupFiles: startupFiles.length > 0 ? startupFiles : undefined,
        startupLinks: startupLinks.length > 0 ? startupLinks : undefined,
      })
      .then((result) => {
        onOpenChange(false);
        navigate(
          `${agentRoute(result.agent.id)}?project=${result.agent.projectId ?? ""}`
        );
      })
      .catch(setFailure);
  }, [
    agentType,
    args,
    argValues,
    launchTemplate,
    model,
    effort,
    effortError,
    modelCatalogLoaded,
    savedOption,
    navigate,
    onOpenChange,
    startupFiles,
    startupLinks,
    template.id,
  ]);

  return (
    <DialogContent busy={launchTemplate.isPending}>
      <DialogHeader>
        <DialogTitle>{template.name}</DialogTitle>
        {template.description ? (
          // A long description scrolls on its own so it cannot push the form
          // body and actions out of the capped dialog.
          <DialogDescription
            data-testid="launch-template-description"
            className="max-h-[min(8rem,20dvh)] overflow-y-auto overscroll-contain"
          >
            {template.description}
          </DialogDescription>
        ) : (
          <DialogDescription>
            This will create a new agent from this template.
          </DialogDescription>
        )}
      </DialogHeader>

      <DialogForm
        data-testid="launch-template-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (allArgsFilled && !effortError && !launchTemplate.isPending)
            handleLaunch();
        }}
        onDragOver={
          showFiles
            ? (event) => {
                if (event.dataTransfer.types.includes("Files")) {
                  event.preventDefault();
                  setDraggingFiles(true);
                }
              }
            : undefined
        }
        onDragLeave={
          showFiles
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
        onDrop={showFiles ? handleStartupDrop : undefined}
      >
        <DialogBody data-testid="launch-template-body">
          <AgentConfigRow showModel={showModelSelect}>
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
                savedOption={savedOption(model)}
                onChange={handleModelChange}
                loading={modelCatalogLoading}
                id="launch-template-model"
                testId="launch-template-model"
              />
            ) : null}
            <AgentEffortSelect
              model={model}
              value={effort}
              onChange={setEffort}
              agentType={agentType}
              id="launch-template-effort"
            />
          </AgentConfigRow>

          {effortError ? (
            <FieldError className="mt-2">{effortError}</FieldError>
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

          {showFiles ? (
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
        </DialogBody>
        {failure ? (
          <Alert title="Couldn’t launch the template." error={failure} />
        ) : null}
        <DialogFooter data-testid="launch-template-actions">
          <DialogCancel />
          <Button
            ref={launchButtonRef}
            type="submit"
            variant="primary"
            pending={launchTemplate.isPending}
            disabled={!allArgsFilled || Boolean(effortError)}
          >
            <Play className="fill-current" />
            Launch agent
          </Button>
        </DialogFooter>
      </DialogForm>
    </DialogContent>
  );
}
