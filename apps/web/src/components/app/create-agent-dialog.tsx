import { useState } from "react";
import { ChevronLeft } from "lucide-react";

import { AgentModelSelect } from "@/components/app/agent-model-select";
import { AgentTypeSelect } from "@/components/app/agent-type-select";
import { ContextPicker } from "@/components/app/context-picker";
import { CONTEXT_PROMPT_ID } from "@/components/app/create-agent-dialog-utils";
import { WorktreeSection } from "@/components/app/create-agent-worktree-section";
import { PathInput } from "@/components/app/path-input";
import { useCreateAgentForm } from "@/components/app/use-create-agent-form";
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
import { type Agent } from "@/components/app/types";
import { useRadixPopoverZFix } from "@/hooks/use-radix-popover-z-fix";
import { type AgentType } from "@/lib/agent-types";
import { swallowEscapeFromCombobox } from "@/lib/dialog-escape";
import { cn } from "@/lib/utils";

type CreateAgentDialogProps = {
  open: boolean;
  enabledAgentTypes: AgentType[];
  initialAgentType: AgentType | null;
  setOpen: (open: boolean) => void;
  resolveDefaultCwd: () => string;
  onCreated: (agent: Agent, agentType: AgentType) => Promise<void>;
};

export function CreateAgentDialog({
  open,
  enabledAgentTypes,
  initialAgentType,
  setOpen,
  resolveDefaultCwd,
  onCreated,
}: CreateAgentDialogProps): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {open ? (
        <CreateAgentDialogContent
          enabledAgentTypes={enabledAgentTypes}
          initialAgentType={initialAgentType}
          setOpen={setOpen}
          resolveDefaultCwd={resolveDefaultCwd}
          onCreated={onCreated}
        />
      ) : null}
    </Dialog>
  );
}

function CreateAgentDialogContent({
  enabledAgentTypes,
  initialAgentType,
  setOpen,
  resolveDefaultCwd,
  onCreated,
}: Omit<CreateAgentDialogProps, "open">): JSX.Element {
  const [typeDropdownOpen, setTypeDropdownOpen] = useState(false);
  const form = useCreateAgentForm({
    enabledAgentTypes,
    initialAgentType,
    resolveDefaultCwd,
    onCreated,
  });

  useRadixPopoverZFix();
  const supportsModelSelection = [
    "codex",
    "claude",
    "cursor",
    "dispatch",
  ].includes(form.createType);
  const showModelSelect =
    supportsModelSelection &&
    (form.modelCatalogLoading || form.modelOptions.length > 0);

  return (
    <DialogContent
      onEscapeKeyDown={(e) => {
        swallowEscapeFromCombobox(e);
        if (e.defaultPrevented) return;
        if (typeDropdownOpen) {
          e.preventDefault();
        }
        if (form.step === "context") {
          e.preventDefault();
          form.setStep("config");
        }
      }}
    >
      {form.step === "config" ? (
        <>
          <DialogHeader>
            <DialogTitle>Create Agent</DialogTitle>
            <DialogDescription>
              Name, type, and working directory for a new agent session.
            </DialogDescription>
          </DialogHeader>

          <form
            data-testid="create-agent-form"
            className="flex min-h-0 flex-col"
            onSubmit={(event) => void form.handleSubmit(event)}
          >
            <div className="min-h-0 flex-1 overflow-y-auto px-1">
              <div className="space-y-3">
                <div
                  className={cn(
                    "grid gap-3",
                    showModelSelect && "min-[420px]:grid-cols-2"
                  )}
                >
                  <AgentTypeSelect
                    value={form.createType}
                    onChange={form.setCreateType}
                    agentTypes={enabledAgentTypes}
                    onOpenChange={setTypeDropdownOpen}
                  />

                  {showModelSelect ? (
                    <AgentModelSelect
                      value={form.createModel}
                      options={form.modelOptions}
                      onChange={form.setCreateModel}
                      loading={form.modelCatalogLoading}
                    />
                  ) : null}
                </div>

                <div className="space-y-1">
                  <label className="text-sm text-muted-foreground">Name</label>
                  <Input
                    autoFocus
                    value={form.createName}
                    onChange={(event) => form.setCreateName(event.target.value)}
                    placeholder="agent name"
                    data-testid="create-agent-name"
                  />
                  <p className="text-xs text-muted-foreground">
                    Leave blank and the agent will set its own name based on the
                    task.
                  </p>
                </div>

                <PathInput
                  value={form.createCwd}
                  onChange={form.setCreateCwd}
                  label="Working directory"
                  history={form.cwdHistory}
                  removableHistory={form.removableCwdHistory}
                  historyMetadata={form.cwdHistoryMetadata}
                  onRemoveHistory={form.removeCwdHistory}
                  onPathInfoChange={form.handlePathInfoChange}
                  data-testid="create-agent-cwd"
                  historyItemTestId="create-agent-cwd-history-option"
                />

                <WorktreeSection
                  cwd={form.createCwd}
                  worktreeAvailable={form.worktreeAvailable}
                  useWorktree={form.createUseWorktree}
                  onUseWorktreeChange={form.setCreateUseWorktree}
                  baseBranch={form.createBaseBranch}
                  onBaseBranchChange={form.setCreateBaseBranch}
                  worktreeBranch={form.createWorktreeBranch}
                  onWorktreeBranchChange={form.setCreateWorktreeBranch}
                  createNewBranch={form.createNewBranch}
                  onCreateNewBranchChange={form.setCreateNewBranch}
                />

                {form.createType !== "terminal" ? (
                  <>
                    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
                      <Checkbox
                        checked={form.createFullAccess}
                        onCheckedChange={() =>
                          form.setCreateFullAccess((current) => !current)
                        }
                        className="mt-0.5"
                        title="Toggle full access"
                      />
                      <span className="space-y-1">
                        <span className="block text-sm font-medium text-foreground">
                          Start in full access mode
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Starts the selected agent with its most permissive
                          supported execution mode.
                        </span>
                      </span>
                    </label>

                    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
                      <Checkbox
                        checked={form.createAutoReview}
                        onCheckedChange={() =>
                          form.setCreateAutoReview((current) => !current)
                        }
                        className="mt-0.5"
                        title="Toggle autonomous review"
                        data-testid="create-agent-auto-review"
                      />
                      <span className="space-y-1">
                        <span className="block text-sm font-medium text-foreground">
                          Autonomous Review
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Agent will launch one review agent and address
                          feedback before completing.
                        </span>
                      </span>
                    </label>
                  </>
                ) : null}
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-3">
              <Button
                type="button"
                variant="ghost"
                tabIndex={0}
                onClick={() => setOpen(false)}
                data-testid="create-agent-cancel"
              >
                Cancel
              </Button>
              {form.createType !== "terminal" ? (
                <Button
                  type="button"
                  variant="default"
                  tabIndex={0}
                  disabled={form.creating || !form.createCwd.trim()}
                  data-testid="create-agent-with-context"
                  onClick={form.enterContextStep}
                >
                  Create with context
                </Button>
              ) : null}
              <Button
                type="submit"
                variant="primary"
                tabIndex={0}
                disabled={form.creating}
                data-testid="create-agent-submit"
              >
                {form.creating ? (
                  <ActivityBars size={16} className="mr-1.5" />
                ) : null}
                Create
              </Button>
            </div>
          </form>
        </>
      ) : (
        <>
          <DialogHeader>
            <DialogTitle>Create with context</DialogTitle>
            <DialogDescription>
              Add startup instructions, files, and links for the agent to use
              when the session starts.
            </DialogDescription>
          </DialogHeader>

          <form
            data-testid="create-agent-context-form"
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => void form.handleSubmit(event)}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes("Files")) {
                event.preventDefault();
                form.setDraggingFiles(true);
              }
            }}
            onDragLeave={(event) => {
              if (
                event.currentTarget.contains(event.relatedTarget as Node | null)
              ) {
                return;
              }
              form.setDraggingFiles(false);
            }}
            onDrop={form.handleStartupDrop}
          >
            <div
              className={cn(
                "min-h-0 flex-1 overflow-y-auto rounded-lg px-1 pb-1"
              )}
            >
              <div className="space-y-3">
                <div className="space-y-1">
                  <label
                    htmlFor={CONTEXT_PROMPT_ID}
                    className="text-sm text-muted-foreground"
                  >
                    Instructions
                  </label>
                  <textarea
                    id={CONTEXT_PROMPT_ID}
                    ref={form.promptTextareaRef}
                    value={form.initialPrompt}
                    onChange={(event) =>
                      form.setInitialPrompt(event.target.value)
                    }
                    onPaste={form.handleStartupPaste}
                    placeholder="Enter instructions for the agent..."
                    data-testid="create-agent-initial-prompt"
                    className={cn(
                      "flex min-h-[180px] w-full resize-y rounded-md border border-white/[0.12] bg-white/[0.04] px-3 py-2 text-sm shadow-[inset_0_2px_6px_rgba(0,0,0,0.3)] backdrop-blur-md",
                      "ring-offset-background placeholder:text-muted-foreground",
                      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    )}
                  />
                </div>

                <ContextPicker
                  files={form.startupFiles}
                  links={form.startupLinks}
                  draggingFiles={form.draggingFiles}
                  filePreviewsRef={form.startupFilePreviewsRef}
                  onAppendFiles={form.appendStartupFiles}
                  onRemoveFile={form.handleRemoveStartupFile}
                  onAddLink={form.handleAddLink}
                  onRemoveLink={form.handleRemoveStartupLink}
                  onClipboardText={form.handleClipboardText}
                  onDraftInvalid={form.setContextDraftInvalid}
                  testIdPrefix="create-agent-context"
                />
              </div>
            </div>

            <div className="flex justify-between gap-2 border-t border-white/[0.08] pt-3">
              <Button
                type="button"
                variant="ghost"
                tabIndex={0}
                className="min-h-11 px-3"
                onClick={() => form.setStep("config")}
                data-testid="create-agent-context-back"
              >
                <ChevronLeft className="mr-1 h-4 w-4" />
                Back
              </Button>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  tabIndex={0}
                  className="min-h-11 px-3"
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  tabIndex={0}
                  className="min-h-11 px-3"
                  disabled={form.creating || form.contextDraftInvalid}
                  data-testid="create-agent-context-submit"
                >
                  {form.creating ? (
                    <ActivityBars size={16} className="mr-1.5" />
                  ) : null}
                  Create
                </Button>
              </div>
            </div>
          </form>
        </>
      )}
    </DialogContent>
  );
}
