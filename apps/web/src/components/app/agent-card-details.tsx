import React from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Folder,
  FolderTree,
  GitBranch,
} from "lucide-react";

import { FrontTruncatedValue } from "@/components/app/agent-meta";
import { DiffStatBadge } from "@/components/app/diff-stat-badge";
import { IdeLaunchButton } from "@/components/app/ide-launch-button";
import { type Agent, type DiffStats } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import {
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
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-muted-foreground/75" title={label}>
        {icon ?? (
          <span className="text-[10px] uppercase tracking-wide">{label}</span>
        )}
      </span>
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
              mono && "font-mono text-[11px]"
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
  diffStats: DiffStats | null | undefined;
  refreshDiffStats: () => void;
  fullAccessEnabled: boolean;
  isTerminalAgent: boolean;
  enabledIdes: IdeType[];
  /**
   * Copy state is owned by the card itself so the "copied" confirmation
   * survives collapsing and reopening the details panel.
   */
  worktreePathCopied: boolean;
  copyWorktreePath: (text: string) => void;
};

/**
 * The location panel inside an expanded agent card: branch/worktree info, diff
 * stats, IDE launch, and the sandbox/full-access indicator.
 */
export function AgentCardDetails({
  agent,
  diffStats,
  refreshDiffStats,
  fullAccessEnabled,
  isTerminalAgent,
  enabledIdes,
  worktreePathCopied,
  copyWorktreePath,
}: AgentCardDetailsProps): JSX.Element {
  const sidebarBaseBranch = agent.baseBranch ?? "main";

  return (
    <div className="relative space-y-2 rounded-xl border border-border/60 bg-background/25 px-3 py-3 text-xs text-muted-foreground">
      <div className="absolute right-3 top-3">
        <DiffStatBadge
          diffStats={diffStats}
          latestEventAt={agent.latestEvent?.updatedAt ?? null}
          onRefresh={refreshDiffStats}
        />
      </div>
      {agent.gitContext?.isWorktree ? (
        <div className="flex items-start justify-between gap-3">
          <span className="shrink-0 text-muted-foreground/75" title="Branch">
            <GitBranch className="h-3.5 w-3.5" />
          </span>
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
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground/50">
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
            value={agent.cwd}
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
      <div className="flex items-center justify-between gap-2 pt-1">
        <div className="flex items-center gap-2">
          {agent.cwd ? (
            <IdeLaunchButton path={agent.cwd} enabledIdes={enabledIdes} />
          ) : null}
          {agent.gitContext?.isWorktree && agent.cwd ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => agent.cwd && copyWorktreePath(agent.cwd)}
                  aria-label={
                    worktreePathCopied
                      ? "Worktree path copied"
                      : `Copy worktree path: ${agent.cwd}`
                  }
                  className="group relative h-auto min-h-6 gap-1 rounded-full border border-border bg-muted/35 px-2 py-0.5 text-[10px] font-normal text-muted-foreground before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-[''] hover:bg-muted/60 hover:text-foreground"
                >
                  {worktreePathCopied ? (
                    <Check className="h-3 w-3 text-status-done" />
                  ) : (
                    <>
                      <FolderTree className="h-3 w-3 group-hover:hidden group-focus-visible:hidden" />
                      <Copy className="hidden h-3 w-3 group-hover:block group-focus-visible:block" />
                    </>
                  )}
                  <span>Worktree</span>
                  <span className="sr-only" aria-live="polite">
                    {worktreePathCopied ? "Worktree path copied" : ""}
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-[420px] break-all">
                {agent.cwd}
                <div className="mt-1 text-[10px] opacity-70">Click to copy</div>
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        {isTerminalAgent ? (
          <span />
        ) : (
          <div
            className={cn(
              "inline-flex min-h-6 items-center gap-1 rounded-full px-2 py-0.5 text-[10px]",
              fullAccessEnabled
                ? "border border-status-waiting/35 bg-status-waiting/10 text-status-waiting"
                : "border border-border bg-muted/40 text-muted-foreground"
            )}
          >
            {fullAccessEnabled ? <AlertTriangle className="h-3 w-3" /> : null}
            <span>{fullAccessEnabled ? "Full access" : "Sandboxed"}</span>
          </div>
        )}
      </div>
    </div>
  );
}
