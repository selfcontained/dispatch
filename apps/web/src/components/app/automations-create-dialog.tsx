import { useCallback, useState } from "react";
import { toast } from "sonner";

import { TemplateConfigFields } from "@/components/app/automations-form-fields";
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
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [directory, setDirectory] = useState("");
  const [prompt, setPrompt] = useState("");
  const [agentType, setAgentType] = useState<AgentType>("claude");
  const [useWorktree, setUseWorktree] = useState(false);
  const [baseBranch, setBaseBranch] = useState("main");
  const [branchName, setBranchName] = useState("");
  const [fullAccess, setFullAccess] = useState(false);
  const [callable, setCallable] = useState(true);
  const [allowMedia, setAllowMedia] = useState(true);
  const [creating, setCreating] = useState(false);

  const handleCreate = useCallback(() => {
    const isTerminal = agentType === "terminal";
    setCreating(true);
    addTemplate
      .mutateAsync({
        name,
        description: description.trim() || null,
        directory,
        prompt: isTerminal ? null : prompt || null,
        agentType,
        useWorktree: isTerminal ? false : useWorktree,
        baseBranch: isTerminal ? null : useWorktree ? baseBranch : null,
        branchName: isTerminal ? null : useWorktree ? branchName || null : null,
        fullAccess: isTerminal ? false : fullAccess,
        callable,
        allowMedia: isTerminal ? false : allowMedia,
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
          in the prompt for optional runtime arguments, with modifiers like{" "}
          <code className="rounded bg-white/[0.08] px-1 text-xs">
            {"{{D:Arg Name|required|multiline}}"}
          </code>
          .
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-1">
        <TemplateConfigFields
          agentType={agentType}
          onAgentTypeChange={setAgentType}
          enabledAgentTypes={enabledAgentTypes}
          name={name}
          onNameChange={setName}
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
          prompt={prompt}
          onPromptChange={setPrompt}
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
