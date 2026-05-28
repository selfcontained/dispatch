import { GitBranch } from "lucide-react";

import { BranchSelect } from "@/components/app/branch-select";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type WorktreeSectionProps = {
  cwd: string;
  worktreeAvailable: boolean;
  worktreeChecked: boolean;
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
  worktreeChecked,
  useWorktree,
  onUseWorktreeChange,
  baseBranch,
  onBaseBranchChange,
  worktreeBranch,
  onWorktreeBranchChange,
  createNewBranch,
  onCreateNewBranchChange,
}: WorktreeSectionProps): JSX.Element {
  const controlsDisabled = !worktreeAvailable || !worktreeChecked;
  const branchOptionsEnabled = worktreeAvailable && worktreeChecked;
  const newBranchChecked = branchOptionsEnabled && createNewBranch;

  return (
    <div
      className={cn(
        "space-y-2 rounded-md border border-border/70 bg-muted/20 px-3 py-3 transition-opacity duration-200",
        !worktreeAvailable && "opacity-60"
      )}
      data-testid="create-agent-worktree-section"
    >
      <label
        className={cn(
          "flex items-start gap-3",
          worktreeAvailable ? "cursor-pointer" : "cursor-not-allowed"
        )}
      >
        <Checkbox
          checked={worktreeChecked}
          onCheckedChange={() => {
            const nextUseWorktree = !useWorktree;
            onUseWorktreeChange(nextUseWorktree);
          }}
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
          <span className="block text-xs text-muted-foreground">
            {worktreeAvailable
              ? "Creates an isolated worktree for this agent. Dispatch tracks and cleans it up when the agent is archived."
              : "Working directory isn't a git repository, so a managed worktree isn't available here."}
          </span>
        </span>
      </label>
      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
          branchOptionsEnabled
            ? "grid-rows-[1fr] opacity-100"
            : "grid-rows-[1fr] opacity-60"
        )}
      >
        <div className="min-h-0">
          <div className="ml-8 w-[calc(100%-2rem)] space-y-3 pt-1">
            <BranchSelect
              cwd={cwd}
              baseBranch={baseBranch}
              onBaseBranchChange={onBaseBranchChange}
              worktreeBranch={worktreeBranch}
              onWorktreeBranchChange={onWorktreeBranchChange}
              baseBranchLabel="Starting branch"
              baseBranchHelper="The branch to check out in the worktree."
              showNewBranchInput={false}
              testIdPrefix="create-agent"
              disabled={controlsDisabled}
            />
            <div className="space-y-2 rounded-md border border-border/60 bg-background/40 px-3 py-3">
              <label
                className={cn(
                  "flex items-start gap-3",
                  controlsDisabled ? "cursor-not-allowed" : "cursor-pointer"
                )}
              >
                <Checkbox
                  checked={newBranchChecked}
                  onCheckedChange={() =>
                    onCreateNewBranchChange(!createNewBranch)
                  }
                  className="mt-0.5"
                  title="Toggle new branch creation"
                  data-testid="create-agent-new-branch"
                  disabled={controlsDisabled}
                />
                <span className="space-y-1">
                  <span className="block text-sm font-medium text-foreground">
                    Create a new branch in this worktree
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Creates a new working branch from the starting branch so the
                    agent can make isolated changes for later submission.
                  </span>
                </span>
              </label>
              <div
                className={cn(
                  "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
                  newBranchChecked
                    ? "grid-rows-[1fr] opacity-100"
                    : "grid-rows-[1fr] opacity-60"
                )}
              >
                <div className="min-h-0">
                  <div className="space-y-1 pt-2">
                    <label className="block text-xs text-muted-foreground">
                      New branch name
                    </label>
                    <Input
                      value={worktreeBranch}
                      onChange={(event) =>
                        onWorktreeBranchChange(event.target.value)
                      }
                      placeholder="auto-generated if empty"
                      data-testid="create-agent-worktree-branch"
                      disabled={controlsDisabled || !newBranchChecked}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
