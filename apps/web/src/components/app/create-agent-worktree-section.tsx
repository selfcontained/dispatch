import { GitBranch, Info } from "lucide-react";

import { BranchSelect } from "@/components/app/branch-select";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type WorktreeSectionProps = {
  cwd: string;
  worktreeAvailable: boolean;
  useWorktree: boolean;
  onUseWorktreeChange: (value: boolean) => void;
  baseBranch: string;
  onBaseBranchChange: (value: string) => void;
  worktreeBranch: string;
  onWorktreeBranchChange: (value: string) => void;
  createNewBranch: boolean;
  onCreateNewBranchChange: (value: boolean) => void;
};

export function WorktreeSection({
  cwd,
  worktreeAvailable,
  useWorktree,
  onUseWorktreeChange,
  baseBranch,
  onBaseBranchChange,
  worktreeBranch,
  onWorktreeBranchChange,
  createNewBranch,
  onCreateNewBranchChange,
}: WorktreeSectionProps): JSX.Element {
  const worktreeChecked = worktreeAvailable && useWorktree;

  return (
    <div
      className={cn(
        "space-y-2 rounded-md border border-border/70 bg-muted/20 px-3 py-3 transition-opacity duration-200",
        !worktreeAvailable && "opacity-60"
      )}
      data-testid="create-agent-worktree-section"
    >
      <div className="flex items-start gap-2">
        <label
          className={cn(
            "flex items-start gap-3",
            worktreeAvailable ? "cursor-pointer" : "cursor-not-allowed"
          )}
        >
          <Checkbox
            checked={worktreeChecked}
            onCheckedChange={(checked) => onUseWorktreeChange(checked === true)}
            disabled={!worktreeAvailable}
            className="mt-0.5"
            title={
              worktreeAvailable
                ? "Toggle managed git worktree"
                : "Not a git repository"
            }
            data-testid="create-agent-worktree"
          />
          <span className="space-y-1">
            <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <GitBranch className="h-3.5 w-3.5" />
              Create managed git worktree
            </span>
            {!worktreeAvailable && (
              <span className="block text-xs text-muted-foreground">
                Requires a Git repository.
              </span>
            )}
          </span>
        </label>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="About managed worktrees"
                className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
              >
                <Info className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">
              Creates an isolated worktree for this agent. Dispatch tracks and
              cleans it up when the agent is archived.
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      {worktreeChecked ? (
        <div className="ml-8 w-[calc(100%-2rem)] space-y-2">
          <BranchSelect
            cwd={cwd}
            baseBranch={baseBranch}
            onBaseBranchChange={onBaseBranchChange}
            worktreeBranch={worktreeBranch}
            onWorktreeBranchChange={onWorktreeBranchChange}
            baseBranchLabel="Starting branch"
            showNewBranchInput={false}
            testIdPrefix="create-agent"
          />
          <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
            <Checkbox
              checked={createNewBranch}
              onCheckedChange={(checked) =>
                onCreateNewBranchChange(checked === true)
              }
              title="Toggle new branch creation"
              data-testid="create-agent-new-branch"
            />
            Create a new branch
          </label>
          {createNewBranch ? (
            <Input
              value={worktreeBranch}
              onChange={(event) => onWorktreeBranchChange(event.target.value)}
              placeholder="branch name (auto-generated if empty)"
              aria-label="New branch name"
              data-testid="create-agent-worktree-branch"
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
