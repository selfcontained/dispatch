import { useEffect, useRef, useState } from "react";
import { panelFrame } from "@/components/ui/card";
import { GitBranch, Info } from "lucide-react";

import { BranchSelect } from "@/components/app/branch-select";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

type WorktreeSectionProps = {
  cwd: string;
  branchesUrl?: string;
  defaultBaseBranch?: string;
  worktreeAvailable: boolean;
  /** Runner projects reserve their branch controls before selection. */
  reserveExpandedSpace?: boolean;
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
  branchesUrl,
  defaultBaseBranch,
  worktreeAvailable,
  reserveExpandedSpace = false,
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
  const expanded = reserveExpandedSpace || worktreeChecked;
  // Clip only while collapsed or animating; once open, let the branch
  // dropdown overflow the section.
  const [openSettled, setOpenSettled] = useState(expanded);
  if (!expanded && openSettled) setOpenSettled(false);
  // React 18 has no `inert` prop; keep collapsed controls out of the tab order.
  const collapsibleRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = collapsibleRef.current;
    if (!el) return;
    if (expanded) el.removeAttribute("inert");
    else el.setAttribute("inert", "");
  }, [expanded]);

  return (
    <div
      className={cn(
        panelFrame,
        "p-3 transition-opacity duration-200",
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
            data-testid="create-agent-worktree"
          />
          <span className="flex h-5 items-center gap-1.5 text-body-md font-medium text-foreground">
            <GitBranch className="h-3.5 w-3.5" />
            Create managed git worktree
          </span>
        </label>
        <IconButton
          size="icon-xs"
          label="About managed worktrees"
          tooltip={
            worktreeAvailable
              ? "Creates an isolated worktree for this agent. Dispatch tracks and cleans it up when the agent is archived."
              : "Requires a Git repository."
          }
        >
          <Info />
        </IconButton>
      </div>
      <div
        ref={collapsibleRef}
        aria-hidden={!expanded}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && expanded) {
            setOpenSettled(true);
          }
        }}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
          expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        )}
      >
        <div
          className={cn(
            "min-h-0",
            !(expanded && openSettled) && "overflow-hidden"
          )}
        >
          <div className="space-y-2 pt-2">
            <div className="ml-8 w-[calc(100%-2rem)]">
              <BranchSelect
                cwd={cwd}
                sourceUrl={branchesUrl}
                defaultBaseBranch={defaultBaseBranch}
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
                className="ml-8 block cursor-pointer text-body-sm font-medium text-foreground"
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
                  aria-label="Toggle new branch creation"
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
