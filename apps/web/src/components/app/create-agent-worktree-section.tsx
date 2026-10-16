import { useEffect, useRef, useState } from "react";
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
  // Clip only while collapsed or animating; once open, let the branch
  // dropdown overflow the section.
  const [openSettled, setOpenSettled] = useState(worktreeChecked);
  if (!worktreeChecked && openSettled) setOpenSettled(false);
  // React 18 has no `inert` prop; keep collapsed controls out of the tab order.
  const collapsibleRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = collapsibleRef.current;
    if (!el) return;
    if (worktreeChecked) el.removeAttribute("inert");
    else el.setAttribute("inert", "");
  }, [worktreeChecked]);

  return (
    <div
      className={cn(
        "rounded-md border border-border/70 bg-muted/20 px-3 py-3 transition-opacity duration-200",
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
            title={
              worktreeAvailable
                ? "Toggle managed git worktree"
                : "Not a git repository"
            }
            data-testid="create-agent-worktree"
          />
          <span className="flex h-5 items-center gap-1.5 text-sm font-medium text-foreground">
            <GitBranch className="h-3.5 w-3.5" />
            Create managed git worktree
          </span>
        </label>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="About managed worktrees"
                className="flex h-5 shrink-0 items-center text-muted-foreground hover:text-foreground"
              >
                <Info className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">
              {worktreeAvailable
                ? "Creates an isolated worktree for this agent. Dispatch tracks and cleans it up when the agent is archived."
                : "Requires a Git repository."}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div
        ref={collapsibleRef}
        aria-hidden={!worktreeChecked}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && worktreeChecked) {
            setOpenSettled(true);
          }
        }}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
          worktreeChecked
            ? "grid-rows-[1fr] opacity-100"
            : "grid-rows-[0fr] opacity-0"
        )}
      >
        <div
          className={cn(
            "min-h-0",
            !(worktreeChecked && openSettled) && "overflow-hidden"
          )}
        >
          <div className="space-y-2 pt-2">
            <div className="ml-8 w-[calc(100%-2rem)]">
              <BranchSelect
                cwd={cwd}
                baseBranch={baseBranch}
                onBaseBranchChange={onBaseBranchChange}
                worktreeBranch={worktreeBranch}
                onWorktreeBranchChange={onWorktreeBranchChange}
                baseBranchLabel="Starting branch"
                showNewBranchInput={false}
                testIdPrefix="create-agent"
                disabled={!worktreeChecked}
              />
            </div>
            <div className="space-y-1">
              <label
                htmlFor="create-agent-new-branch"
                className="ml-8 block cursor-pointer text-xs text-muted-foreground"
              >
                New branch
              </label>
              <div className="flex items-center gap-3">
                <Checkbox
                  id="create-agent-new-branch"
                  checked={createNewBranch}
                  onCheckedChange={(checked) =>
                    onCreateNewBranchChange(checked === true)
                  }
                  title="Toggle new branch creation"
                  data-testid="create-agent-new-branch"
                  disabled={!worktreeChecked}
                />
                <Input
                  value={createNewBranch ? worktreeBranch : ""}
                  onChange={(event) =>
                    onWorktreeBranchChange(event.target.value)
                  }
                  placeholder={createNewBranch ? "auto-generated if empty" : ""}
                  aria-label="New branch name"
                  data-testid="create-agent-worktree-branch"
                  disabled={!worktreeChecked || !createNewBranch}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
