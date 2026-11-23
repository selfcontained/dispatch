import { AgentPreview } from "./agent-preview";
import React from "react";
import { AssignedTaskRow } from "./assigned-task-row";
import { AgentPullRequests } from "./agent-pull-requests";
import {
  Check,
  Copy,
  Folder,
  FolderTree,
  GitBranch,
  UserRound,
} from "lucide-react";

import { FrontTruncatedValue } from "@/components/app/agent-meta";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { ChangeWorkspaceButton } from "@/components/app/change-workspace-dialog";
import { DiffStatBadge } from "@/components/app/diff-stat-badge";
import { IdeLaunchButton } from "@/components/app/ide-launch-button";
import { type Agent, type DiffStats } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import {
  agentModelLabel,
  useAgentModelCatalogData,
} from "@/hooks/use-agent-model-catalog";
import {
  Hint,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { type IdeType } from "@/lib/ide-types";
import { cn } from "@/lib/utils";

function CompactMetaRow({
  label,
  icon,
  value,
  mono = false,
  truncateStart = false,
}: {
  label: string;
  icon?: React.ReactNode;
  value: string;
  mono?: boolean;
  truncateStart?: boolean;
}): JSX.Element {
  return (
    <div className="flex min-h-7 items-center justify-between gap-3">
      {icon ? (
        <Hint label={label}>
          <span role="img" aria-label={label} className="shrink-0 text-faint">
            {icon}
          </span>
        </Hint>
      ) : (
        <span className="shrink-0 section-label">{label}</span>
      )}
      <div className="min-w-0 flex-1 text-left">
        {truncateStart ? (
          <FrontTruncatedValue
            value={value}
            mono={mono}
            className="text-left text-foreground"
            tooltipClassName="max-w-[420px]"
          />
        ) : (
          <div
            className={cn(
              "text-foreground break-all",
              mono && "font-mono text-label-sm"
            )}
          >
            {value}
          </div>
        )}
      </div>
    </div>
  );
}

export type AgentCardDetailsProps = {
  agent: Agent;
  personaParentName?: React.ReactNode;
  diffStats: DiffStats | null | undefined;
  refreshDiffStats: () => void;
  fullAccessEnabled: boolean;
  enabledIdes: IdeType[];
  /**
   * Copy state is owned by the card itself so the "copied" confirmation
   * survives collapsing and reopening the details panel.
   */
  worktreePathCopied: boolean;
  copyWorktreePath: (text: string) => void;
};

/**
 * The location panel inside an expanded agent card: branch/worktree info, the
 * engine and model, diff stats, IDE launch, and the sandbox/full-access
 * indicator.
 */
export function AgentCardDetails({
  agent,
  personaParentName,
  diffStats,
  refreshDiffStats,
  fullAccessEnabled,
  enabledIdes,
  worktreePathCopied,
  copyWorktreePath,
}: AgentCardDetailsProps): JSX.Element {
  // A moved workspace is where the agent works now; the launch cwd is only
  // where its engine runs.
  const workspaceDir = agent.workspacePath ?? agent.cwd;
  const sidebarBaseBranch =
    (agent.workspacePath ? agent.workspaceBaseBranch : agent.baseBranch) ??
    "main";
  const modelCatalog = useAgentModelCatalogData();

  return (
    <div className="relative flex flex-col gap-2 rounded-lg border border-border-subtle bg-background/tint-strong px-3 py-3 text-body-sm text-muted-foreground">
      {/* Concentric with the rounded-xl corner: 11px inner radius minus this
          3px gap leaves the ~8px radius of the 16px-tall pill. */}
      <div className="absolute right-[3px] top-[3px]">
        <DiffStatBadge diffStats={diffStats} onRefresh={refreshDiffStats} />
      </div>
      {agent.gitContext?.isWorktree ? (
        <div className="flex items-start justify-between gap-3">
          <Hint label="Branch">
            <span
              role="img"
              aria-label="Branch"
              className="shrink-0 text-faint"
            >
              <GitBranch className="size-icon-md" />
            </span>
          </Hint>
          <div className="min-w-0 flex-1 text-left">
            <div className="text-muted-foreground">
              <FrontTruncatedValue
                value={sidebarBaseBranch}
                mono
                className="text-left text-muted-foreground"
                tooltipClassName=""
                tooltipValue={`Base branch: ${sidebarBaseBranch}`}
              />
            </div>
            <div className="mt-0.5 flex items-center gap-1 pl-2">
              <span className="shrink-0 font-mono text-label-sm text-faint">
                ↳
              </span>
              <FrontTruncatedValue
                value={agent.gitContext.branch}
                mono
                className="text-left"
                tooltipValue={`Working branch: ${agent.gitContext.branch}`}
              />
            </div>
          </div>
        </div>
      ) : (
        <>
          <CompactMetaRow
            label="Working dir"
            icon={<Folder className="h-3.5 w-3.5" />}
            value={workspaceDir}
            mono
            truncateStart
          />
          {agent.gitContext ? (
            <CompactMetaRow
              label="Branch"
              icon={<GitBranch className="h-3.5 w-3.5" />}
              value={agent.gitContext.branch}
              mono
              truncateStart
            />
          ) : null}
        </>
      )}
      <CompactMetaRow
        label="Engine"
        icon={
          <AgentTypeIcon
            type={agent.type}
            className="h-3.5 w-3.5 border-0 bg-transparent [&_svg]:h-3.5 [&_svg]:w-3.5"
          />
        }
        value={
          agent.model
            ? agentModelLabel(modelCatalog, agent.type, agent.model)
            : (agent.type ?? "agent")
        }
        mono
      />

      {agent.persona ? (
        <div className="space-y-0.5">
          <CompactMetaRow
            label="Persona"
            icon={<UserRound className="h-3.5 w-3.5" />}
            value={agent.persona}
            mono
          />
          {personaParentName ? (
            <div className="pl-6 text-label-xs text-muted-foreground">
              from {personaParentName}
            </div>
          ) : null}
        </div>
      ) : null}
      <AssignedTaskRow agentId={agent.id} />
      <AgentPullRequests agentId={agent.id} agentName={agent.name} />
      <AgentPreview agentId={agent.id} />

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <div className="flex flex-wrap items-center gap-2">
          {workspaceDir ? (
            <IdeLaunchButton path={workspaceDir} enabledIdes={enabledIdes} />
          ) : null}
          <ChangeWorkspaceButton agent={agent} />
          {agent.gitContext?.isWorktree && workspaceDir ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="xs"
                  onClick={() => workspaceDir && copyWorktreePath(workspaceDir)}
                  aria-label={
                    worktreePathCopied
                      ? "Worktree path copied"
                      : `Copy worktree path: ${workspaceDir}`
                  }
                  className="group font-normal text-muted-foreground hover:text-foreground"
                >
                  {worktreePathCopied ? (
                    <Check className="text-info" />
                  ) : (
                    <>
                      <FolderTree className="group-hover:hidden group-focus-visible:hidden" />
                      <Copy className="hidden group-hover:block group-focus-visible:block" />
                    </>
                  )}
                  <span>Worktree</span>
                  <span className="sr-only" aria-live="polite">
                    {worktreePathCopied ? "Worktree path copied" : ""}
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-[420px] break-all">
                {workspaceDir}
                <div className="mt-1 text-label-xs opacity-70">
                  Click to copy
                </div>
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        {!fullAccessEnabled ? (
          <Hint label="Uses engine permission checks; approval requests appear in chat.">
            <span className="text-label-xs text-muted-foreground">
              Restricted access
            </span>
          </Hint>
        ) : null}
      </div>
    </div>
  );
}
