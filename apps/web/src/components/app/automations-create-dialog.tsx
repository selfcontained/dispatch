import { type Project, useProjectScope } from "@/hooks/use-projects";
import { useCallback, useState } from "react";

import { TemplateConfigFields } from "@/components/app/automations-form-fields";
import {
  EMPTY_TEMPLATE_DRAFT,
  templateConfigFromDraft,
  useTemplateDraft,
} from "@/components/app/automations-template-draft";
import { useCwdHistory } from "@/components/app/create-agent-dialog-utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { type Template, useTemplateActions } from "@/hooks/use-templates";
import { type AgentType } from "@/lib/agent-types";
import { Alert } from "@/components/ui/alert";

type CreateTemplateDialogProps = {
  onOpenChange: (open: boolean) => void;
  enabledAgentTypes: AgentType[];
  /** Creates the template in this project, with the location locked. */
  project?: Pick<Project, "id" | "repoRoot"> & { name?: string };
  onCreated?: (template: Template) => void;
  onCloseAutoFocus?: (event: Event) => void;
};

export function CreateTemplateDialog({
  open,
  ...props
}: CreateTemplateDialogProps & { open: boolean }): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      {open ? <CreateTemplateDialogContent {...props} /> : null}
    </Dialog>
  );
}

function CreateTemplateDialogContent({
  onOpenChange,
  enabledAgentTypes,
  project: projectOverride,
  onCreated,
  onCloseAutoFocus,
}: CreateTemplateDialogProps): JSX.Element {
  const scope = useProjectScope();
  const project = projectOverride ?? scope.project;
  const { addTemplate } = useTemplateActions();
  const { draft, fieldProps } = useTemplateDraft({
    ...EMPTY_TEMPLATE_DRAFT,
    projectId: project?.id ?? null,
    directory: project?.repoRoot ?? "",
  });
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const { add: addCwdHistory } = useCwdHistory();

  const handleCreate = useCallback(() => {
    setCreating(true);
    setFailure(undefined);
    addTemplate
      .mutateAsync({
        name: draft.name,
        directory: draft.directory,
        model: draft.model,
        ...templateConfigFromDraft(draft),
        ...(projectOverride && {
          projectId: projectOverride.id,
          directory: projectOverride.repoRoot ?? "",
        }),
      })
      .then((template) => {
        addCwdHistory(draft.directory);
        onCreated?.(template);
        onOpenChange(false);
      })
      .catch(setFailure)
      .finally(() => setCreating(false));
  }, [
    addTemplate,
    draft,
    projectOverride,
    addCwdHistory,
    onCreated,
    onOpenChange,
  ]);

  const canCreate =
    draft.name.trim() &&
    (projectOverride
      ? (projectOverride.repoRoot ?? "")
      : draft.directory
    ).trim();

  return (
    <DialogContent
      size="lg"
      phone="fill"
      busy={creating}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <DialogHeader>
        <DialogTitle>New template</DialogTitle>
        <DialogDescription>
          A reusable agent launch configuration. Use{" "}
          <code className="rounded-sm bg-fill-hover px-1 text-body-sm">
            {"{{D:Arg Name}}"}
          </code>{" "}
          in the prompt for optional runtime arguments, with modifiers like{" "}
          <code className="rounded-sm bg-fill-hover px-1 text-body-sm">
            {"{{D:Arg Name|required|multiline}}"}
          </code>
          . Prefill with <code>{"|default=main"}</code> or offer a dropdown with{" "}
          <code>{"|options=dev,staging,production|default=staging"}</code>.
          Modifiers work in any order.
        </DialogDescription>
      </DialogHeader>

      <DialogBody>
        <TemplateConfigFields
          {...fieldProps}
          enabledAgentTypes={enabledAgentTypes}
          lockedLocation={projectOverride}
          autoFocusName
        />
      </DialogBody>
      {failure ? (
        <Alert title="Couldn’t create the template." error={failure} />
      ) : null}
      <DialogFooter>
        <DialogCancel />
        <Button
          variant="primary"
          onClick={handleCreate}
          pending={creating}
          disabled={!canCreate}
        >
          Create template
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
