import { useMemo } from "react";
import { GitBranch, Paperclip } from "lucide-react";

import { AgentTypeSelect } from "@/components/app/agent-type-select";
import { AgentModelSelect } from "@/components/app/agent-model-select";
import { useAgentModelCatalog } from "@/hooks/use-agent-model-catalog";
import { BranchSelect } from "@/components/app/branch-select";
import { useCwdHistory } from "@/components/app/create-agent-dialog-utils";
import { PathInput } from "@/components/app/path-input";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { type AgentType } from "@/lib/agent-types";
import { parseTemplateArgs } from "@/hooks/use-templates";
import { cn } from "@/lib/utils";

export function TemplateWorktreeOption({
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

export function TemplateFullAccessOption({
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

export interface TemplateConfigFieldsProps {
  agentType: AgentType;
  onAgentTypeChange: (value: AgentType) => void;
  model: string | null;
  onModelChange: (value: string | null) => void;
  enabledAgentTypes: AgentType[];
  name: string;
  onNameChange: (value: string) => void;
  description: string;
  onDescriptionChange: (value: string) => void;
  directory: string;
  onDirectoryChange: (value: string) => void;
  useWorktree: boolean;
  onUseWorktreeChange: (checked: boolean) => void;
  baseBranch: string;
  onBaseBranchChange: (value: string) => void;
  branchName: string;
  onBranchNameChange: (value: string) => void;
  fullAccess: boolean;
  onFullAccessChange: (checked: boolean) => void;
  callable: boolean;
  onCallableChange: (checked: boolean) => void;
  allowMedia: boolean;
  onAllowMediaChange: (checked: boolean) => void;
  selfImprove: boolean;
  onSelfImproveChange: (checked: boolean) => void;
  prompt: string;
  onPromptChange: (value: string) => void;
  autoFocusName?: boolean;
}

export function TemplateConfigFields({
  agentType,
  onAgentTypeChange,
  model,
  onModelChange,
  enabledAgentTypes,
  name,
  onNameChange,
  description,
  onDescriptionChange,
  directory,
  onDirectoryChange,
  useWorktree,
  onUseWorktreeChange,
  baseBranch,
  onBaseBranchChange,
  branchName,
  onBranchNameChange,
  fullAccess,
  onFullAccessChange,
  callable,
  onCallableChange,
  allowMedia,
  onAllowMediaChange,
  selfImprove,
  onSelfImproveChange,
  prompt,
  onPromptChange,
  autoFocusName,
}: TemplateConfigFieldsProps): JSX.Element {
  const isTerminal = agentType === "terminal";
  const { options: modelOptions, loading: modelCatalogLoading } =
    useAgentModelCatalog(agentType);
  const {
    history: cwdHistory,
    removableHistory: removableCwdHistory,
    historyMetadata: cwdHistoryMetadata,
    remove: removeCwdHistory,
  } = useCwdHistory();

  const detectedArgs = useMemo(
    () => (prompt ? parseTemplateArgs(prompt) : []),
    [prompt]
  );

  return (
    <div className="space-y-3">
      <div className="grid gap-3 min-[420px]:grid-cols-2">
        <AgentTypeSelect
          label="Agent type"
          // The template detail page keeps this form mounted behind the launch
          // dialog, so both agent-type selects need distinct ids.
          id="template-config-agent-type"
          value={agentType}
          onChange={(nextAgentType) => {
            onAgentTypeChange(nextAgentType);
            onModelChange(null);
          }}
          agentTypes={enabledAgentTypes}
        />
        {modelOptions.length > 0 || modelCatalogLoading ? (
          <AgentModelSelect
            value={model}
            options={modelOptions}
            onChange={onModelChange}
            loading={modelCatalogLoading}
          />
        ) : null}
      </div>

      <div className="space-y-1">
        <label className="text-sm text-muted-foreground">Name</label>
        <Input
          autoFocus={autoFocusName}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="template name"
        />
      </div>

      <div className="space-y-1">
        <label className="text-sm text-muted-foreground">Description</label>
        <Input
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder="Optional short description"
        />
      </div>

      <div className="space-y-1">
        <label className="text-sm text-muted-foreground">
          Working directory
        </label>
        <PathInput
          value={directory}
          onChange={onDirectoryChange}
          placeholder="/path/to/repo"
          history={cwdHistory}
          removableHistory={removableCwdHistory}
          historyMetadata={cwdHistoryMetadata}
          onRemoveHistory={removeCwdHistory}
        />
      </div>

      {!isTerminal ? (
        <>
          <TemplateWorktreeOption
            checked={useWorktree}
            cwd={directory}
            baseBranch={baseBranch}
            branchName={branchName}
            onCheckedChange={onUseWorktreeChange}
            onBaseBranchChange={onBaseBranchChange}
            onBranchNameChange={onBranchNameChange}
          />

          <TemplateFullAccessOption
            checked={fullAccess}
            onCheckedChange={onFullAccessChange}
          />
        </>
      ) : null}

      <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
        <Checkbox
          checked={callable}
          onCheckedChange={() => onCallableChange(!callable)}
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

      {!isTerminal ? (
        <>
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
            <Checkbox
              checked={allowMedia}
              onCheckedChange={() => onAllowMediaChange(!allowMedia)}
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
            <Textarea
              value={prompt}
              onChange={(e) => onPromptChange(e.target.value)}
              placeholder="Describe what the agent should do..."
              className={cn(
                "min-h-64 resize-y",
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
                    {a.required ? " *" : ""}
                    {a.multiline ? " (multiline)" : ""}
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
            <Checkbox
              checked={selfImprove}
              onCheckedChange={() => onSelfImproveChange(!selfImprove)}
              className="mt-0.5"
            />
            <span className="space-y-1">
              <span className="block text-sm font-medium text-foreground">
                Self improve after each run
              </span>
              <span className="block text-xs text-muted-foreground">
                Ask the agent to make a conservative saved-prompt improvement
                when it finds one.
              </span>
            </span>
          </label>
        </>
      ) : null}
    </div>
  );
}
