import { LaunchTargetError } from "./launch-target-error";
import type { TemplateTarget } from "./use-template-target";
import { RunnerPicker } from "./runner-picker";
import { RunnerProjectPicker } from "./runner-project-picker";
import { AgentConfigRow } from "./agent-config-row";
import { Panel } from "@/components/ui/card";
import type { Effort } from "@dispatch/shared";
import { AgentEffortSelect } from "./agent-effort-select";
import { ProjectLocation } from "./project-location";
import { useId, useMemo } from "react";
import { GitBranch, Paperclip } from "lucide-react";

import { AgentTypeSelect } from "@/components/app/agent-type-select";
import { AgentPersonaSelect } from "@/components/app/agent-persona-select";
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
import { Field } from "@/components/ui/field";
import { OptionCard } from "@/components/ui/setting-row";

export function TemplateWorktreeOption({
  checked,
  cwd,
  baseBranch,
  branchName,
  onCheckedChange,
  onBaseBranchChange,
  onBranchNameChange,
  branchesUrl,
  defaultBaseBranch,
}: {
  checked: boolean;
  branchesUrl?: string;
  defaultBaseBranch?: string;
  cwd: string;
  baseBranch: string;
  branchName: string;
  onCheckedChange: (checked: boolean) => void;
  onBaseBranchChange: (value: string) => void;
  onBranchNameChange: (value: string) => void;
}): JSX.Element {
  return (
    <OptionCard
      label={
        <span className="flex items-center gap-1.5">
          <GitBranch className="size-icon-md" />
          Run in a git worktree
        </span>
      }
      description="Creates an isolated worktree when this template is launched."
      details={
        checked ? (
          <div className="ml-8">
            <BranchSelect
              cwd={cwd}
              sourceUrl={branchesUrl}
              defaultBaseBranch={defaultBaseBranch}
              baseBranch={baseBranch}
              onBaseBranchChange={onBaseBranchChange}
              worktreeBranch={branchName}
              onWorktreeBranchChange={onBranchNameChange}
              testIdPrefix="template-worktree"
            />
          </div>
        ) : null
      }
    >
      <Checkbox
        checked={checked}
        onCheckedChange={() => onCheckedChange(!checked)}
      />
    </OptionCard>
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
    <OptionCard
      label="Start in full access mode"
      description="Starts the selected agent with its most permissive supported execution mode."
    >
      <Checkbox
        checked={checked}
        onCheckedChange={() => onCheckedChange(!checked)}
      />
    </OptionCard>
  );
}

export interface TemplateConfigFieldsProps {
  target?: TemplateTarget;
  agentType: AgentType;
  onAgentTypeChange: (value: AgentType) => void;
  persona?: string | null;
  onPersonaChange: (value: string | null) => void;
  model: string | null;
  effort?: Effort | null;
  onEffortChange: (value: Effort | null) => void;
  onModelChange: (value: string | null) => void;
  enabledAgentTypes: AgentType[];
  name: string;
  onNameChange: (value: string) => void;
  description: string;
  onDescriptionChange: (value: string) => void;
  directory: string;
  projectId?: string | null;
  onProjectChange?: (id: string | null, directory: string) => void;
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
  allowFiles: boolean;
  onAllowFilesChange: (checked: boolean) => void;
  selfImprove: boolean;
  onSelfImproveChange: (checked: boolean) => void;
  prompt: string;
  onPromptChange: (value: string) => void;
  autoFocusName?: boolean;
  /** Shows this location read-only instead of the project/folder picker. */
  lockedLocation?: { name?: string; repoRoot: string | null };
}

export function TemplateConfigFields({
  agentType,
  onAgentTypeChange,
  model,
  effort,
  onEffortChange,
  onModelChange,
  persona,
  onPersonaChange,
  enabledAgentTypes,
  name,
  onNameChange,
  description,
  onDescriptionChange,
  directory,
  projectId,
  onProjectChange,
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
  allowFiles,
  onAllowFilesChange,
  selfImprove,
  onSelfImproveChange,
  prompt,
  onPromptChange,
  autoFocusName,
  lockedLocation,
  target,
}: TemplateConfigFieldsProps): JSX.Element {
  const effortId = useId();
  const {
    options: modelOptions,
    savedOption,
    loading: modelCatalogLoading,
  } = useAgentModelCatalog(
    agentType,
    true,
    target
      ? { data: target.data.info?.catalog, loading: target.models.loading }
      : undefined
  );
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
      {target ? (
        <RunnerPicker
          targets={target.launch.list.data ?? []}
          value={target.launch.key}
          onChange={target.choose}
        />
      ) : null}
      {target ? (
        <LaunchTargetError queries={[target.launch.list, target.data]} />
      ) : null}
      <AgentConfigRow
        showModel={modelOptions.length > 0 || modelCatalogLoading}
      >
        <AgentTypeSelect
          label="Agent type"
          // The template detail page keeps this form mounted behind the launch
          // dialog, so both agent-type selects need distinct ids.
          id="template-config-agent-type"
          value={agentType}
          onChange={(nextAgentType) => {
            onAgentTypeChange(nextAgentType);
            onModelChange(null);
            onEffortChange(null);
          }}
          agentTypes={target?.data.info?.agentTypes ?? enabledAgentTypes}
        />
        {modelOptions.length > 0 || modelCatalogLoading ? (
          <AgentModelSelect
            value={model}
            options={modelOptions}
            savedOption={savedOption(model)}
            onChange={onModelChange}
            loading={modelCatalogLoading}
          />
        ) : null}
        <AgentEffortSelect
          model={model}
          workload={Boolean(target)}
          workloadChoices={target?.data.effort}
          value={effort ?? null}
          onChange={onEffortChange}
          agentType={agentType}
          id={`template-config-effort-${effortId}`}
        />
      </AgentConfigRow>

      <Field label="Name">
        <Input
          autoFocus={autoFocusName}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="template name"
        />
      </Field>

      <Field label="Description" optional>
        <Input
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder="Optional short description"
        />
      </Field>

      {target?.launch.target?.location.kind === "project" ? (
        <RunnerProjectPicker
          projects={target.launch.target.location.projects ?? []}
          projectId={projectId ?? null}
          loading={target.launch.list.isLoading}
          error={Boolean(target.launch.target.location.error)}
          onProject={(id) => onProjectChange?.(id, "")}
        />
      ) : lockedLocation ? (
        <div className="space-y-1.5" data-testid="locked-location">
          <p className="text-body-sm font-medium">Project</p>
          <Panel className="py-2 text-body-md">
            {lockedLocation.name ? (
              <div className="truncate">{lockedLocation.name}</div>
            ) : null}
            <div className="truncate text-body-sm text-muted-foreground">
              {lockedLocation.repoRoot}
            </div>
          </Panel>
        </div>
      ) : (
        <div className="space-y-1">
          <ProjectLocation
            projectId={projectId}
            onChange={(p) =>
              onProjectChange?.(p?.id ?? null, p?.repoRoot ?? directory)
            }
          >
            <PathInput
              value={directory}
              onChange={onDirectoryChange}
              placeholder="/path/to/repo"
              history={cwdHistory}
              removableHistory={removableCwdHistory}
              historyMetadata={cwdHistoryMetadata}
              onRemoveHistory={removeCwdHistory}
            />
          </ProjectLocation>
        </div>
      )}

      <AgentPersonaSelect
        cwd={directory}
        endpoint={
          target && (directory.trim() || projectId)
            ? (target.data.data?.personasUrl ?? "")
            : undefined
        }
        value={persona ?? null}
        onChange={onPersonaChange}
      />

      <>
        <TemplateWorktreeOption
          checked={useWorktree}
          branchesUrl={target?.data.branchesUrl}
          defaultBaseBranch={target?.data.defaultBaseBranch}
          cwd={directory}
          baseBranch={baseBranch}
          branchName={branchName}
          onCheckedChange={onUseWorktreeChange}
          onBaseBranchChange={onBaseBranchChange}
          onBranchNameChange={onBranchNameChange}
        />

        {agentType !== "opencode" && (
          <TemplateFullAccessOption
            checked={fullAccess}
            onCheckedChange={onFullAccessChange}
          />
        )}
      </>

      <OptionCard
        label="Show in command palette"
        description={<>Launch this template from the {"⌘"}K palette.</>}
      >
        <Checkbox
          checked={callable}
          onCheckedChange={() => onCallableChange(!callable)}
        />
      </OptionCard>

      <OptionCard
        label={
          <span className="flex items-center gap-1.5">
            <Paperclip className="size-icon-md" />
            Allow file attachments on launch
          </span>
        }
        description="Show a context area for files and links when launching this template."
      >
        <Checkbox
          checked={allowFiles}
          onCheckedChange={() => onAllowFilesChange(!allowFiles)}
        />
      </OptionCard>

      <Field
        label="Prompt"
        hint={
          prompt.trim() && !detectedArgs.length ? null : (
            <>
              {prompt.trim() ? null : (
                <p>
                  Launched from a task it gets the task as its prompt; otherwise
                  it needs a prompt or a persona.
                </p>
              )}
              {detectedArgs.length > 0 ? (
                <div>
                  Detected arguments:{" "}
                  {detectedArgs.map((a) => (
                    <span
                      key={a.key}
                      className="mr-1.5 inline-block rounded-sm bg-surface-selected px-1.5 py-0.5 text-primary"
                    >
                      {a.name}
                      {a.required ? " *" : ""}
                      {a.multiline ? " (multiline)" : ""}
                      {a.error ? ` — ${a.error}` : ""}
                    </span>
                  ))}
                </div>
              ) : null}
            </>
          )
        }
      >
        <Textarea
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          placeholder="Describe what the agent should do..."
          className="min-h-64 resize-y"
        />
      </Field>

      <OptionCard
        label="Self improve after each run"
        description="Ask the agent to make a conservative saved-prompt improvement when it finds one."
      >
        <Checkbox
          checked={selfImprove}
          onCheckedChange={() => onSelfImproveChange(!selfImprove)}
        />
      </OptionCard>
    </div>
  );
}
