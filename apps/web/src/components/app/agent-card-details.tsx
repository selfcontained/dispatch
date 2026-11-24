import { AgentPreview } from "./agent-preview";
import React from "react";
import { AssignedTaskRow } from "./assigned-task-row";
import { AgentPullRequests } from "./agent-pull-requests";
import { Folder, GitBranch, UserRound } from "lucide-react";

import { FrontTruncatedValue } from "@/components/app/agent-meta";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { DiffStatBadge } from "@/components/app/diff-stat-badge";
import { type Agent, type DiffStats } from "@/components/app/types";
import {
  agentModelLabel,
  useAgentModelCatalogData,
} from "@/hooks/use-agent-model-catalog";
import { Hint } from "@/components/ui/tooltip";
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
  /** Rows that continue the panel on its icon column (sub agents, reviews). */
  children?: React.ReactNode;
};

/**
 * The panel inside an expanded agent card: branch/worktree info, the engine
 * and model, diff stats, task, PR and preview links, then whatever rows the
 * card adds (sub agents, reviews) and the sandbox/full-access indicator.
 */
export function AgentCardDetails({
  agent,
  personaParentName,
  diffStats,
  refreshDiffStats,
  fullAccessEnabled,
  children,
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

      {children}
      {!fullAccessEnabled ? (
        <Hint label="Uses engine permission checks; approval requests appear in chat.">
          <span className="w-fit text-label-xs text-faint">
            Restricted access
          </span>
        </Hint>
      ) : null}
    </div>
  );
}
