import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useId } from "react";
import { Input } from "@/components/ui/input";
import { parseRunnerRepositoryUrl } from "@dispatch/runner-protocol";

export type RunnerBranchMode = "new" | "existing";

export function isRepositoryUrl(value: string) {
  return parseRunnerRepositoryUrl(value) !== null;
}

export function RunnerRepositoryFields({
  mode,
  onMode,
  branch,
  onBranch,
}: {
  mode: RunnerBranchMode;
  onMode: (mode: RunnerBranchMode) => void;
  branch: string;
  onBranch: (branch: string) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <div className="space-y-1 text-sm">
        <label id={id + "-branch-mode"}>Branch</label>
        <Select
          value={mode}
          onValueChange={(value) => onMode(value as RunnerBranchMode)}
        >
          <SelectTrigger aria-labelledby={id + "-branch-mode"}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="new">Create a session branch</SelectItem>
            <SelectItem value="existing">
              Use an existing branch or PR
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <label className="block space-y-1 text-sm">
        <span>{mode === "new" ? "Base branch" : "Branch or pull request"}</span>
        <Input
          value={branch}
          onChange={(e) => onBranch(e.target.value)}
          placeholder={
            mode === "new"
              ? "Repository default"
              : "Branch name or GitHub PR URL"
          }
        />
      </label>
      <p className="text-xs text-muted-foreground">
        Archiving removes the session worktree. Commit and push changes you want
        to keep.
      </p>
    </div>
  );
}
