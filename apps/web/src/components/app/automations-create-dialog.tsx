import { useCallback, useState } from "react";
import { toast } from "sonner";

import { TemplateConfigFields } from "@/components/app/automations-form-fields";
import {
  EMPTY_TEMPLATE_DRAFT,
  templateConfigFromDraft,
  useTemplateDraft,
} from "@/components/app/automations-template-draft";
import { useCwdHistory } from "@/components/app/create-agent-dialog-utils";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTemplateActions } from "@/hooks/use-templates";
import { type AgentType } from "@/lib/agent-types";
import { swallowEscapeFromCombobox } from "@/lib/dialog-escape";

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
  const { draft, fieldProps } = useTemplateDraft(EMPTY_TEMPLATE_DRAFT);
  const [creating, setCreating] = useState(false);
  const { add: addCwdHistory } = useCwdHistory();

  const handleCreate = useCallback(() => {
    setCreating(true);
    addTemplate
      .mutateAsync({
        name: draft.name,
        directory: draft.directory,
        model: draft.model,
        ...templateConfigFromDraft(draft),
      })
      .then(() => {
        addCwdHistory(draft.directory);
        onOpenChange(false);
        toast.success("Template created.");
      })
      .catch((err: Error) => {
        toast.error(`Failed to create template: ${err.message}`);
      })
      .finally(() => setCreating(false));
  }, [addTemplate, draft, addCwdHistory, onOpenChange]);

  const canCreate = draft.name.trim() && draft.directory.trim();

  return (
    <DialogContent
      className="md:h-[min(760px,88vh)] md:w-[min(760px,calc(100vw-2rem))] md:max-w-none"
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
          in the prompt for optional runtime arguments, with modifiers like{" "}
          <code className="rounded bg-white/[0.08] px-1 text-xs">
            {"{{D:Arg Name|required|multiline}}"}
          </code>
          .
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-1">
        <TemplateConfigFields
          {...fieldProps}
          enabledAgentTypes={enabledAgentTypes}
          autoFocusName
        />
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
