import { useId } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type Runner } from "@/hooks/use-runners";

const THIS_MAC = "__local__";

/** "Runs on" picker: This Mac by default, or a paired runner + workspace. */
export function RunnerPicker({
  runners,
  runnerId,
  onRunnerChange,
  workspace,
  onWorkspaceChange,
}: {
  runners: Runner[];
  runnerId: string | null;
  onRunnerChange: (id: string | null) => void;
  workspace: string | null;
  onWorkspaceChange: (workspace: string) => void;
}): JSX.Element | null {
  const runnerLabelId = useId();
  const workspaceLabelId = useId();
  const usable = runners.filter((r) => r.status !== "revoked");
  if (usable.length === 0) return null;
  const selected = usable.find((r) => r.id === runnerId);
  return (
    <div className="space-y-2" data-testid="runner-picker">
      <div className="space-y-1">
        <label id={runnerLabelId} className="text-sm text-muted-foreground">
          Runs on
        </label>
        <Select
          value={runnerId ?? THIS_MAC}
          onValueChange={(next) => {
            if (next) onRunnerChange(next === THIS_MAC ? null : next);
          }}
        >
          <SelectTrigger
            aria-labelledby={runnerLabelId}
            data-testid="create-agent-runner"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={THIS_MAC}>This Mac</SelectItem>
            {usable.map((runner) => (
              <SelectItem
                key={runner.id}
                value={runner.id}
                disabled={runner.status !== "online"}
                data-testid={`create-agent-runner-option-${runner.id}`}
              >
                {runner.name}
                {runner.status === "online" ? "" : ` (${runner.status})`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {selected ? (
        <div className="space-y-1">
          <label
            id={workspaceLabelId}
            className="text-sm text-muted-foreground"
          >
            Workspace
          </label>
          {selected.workspaces.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This runner has not reported any workspaces.
            </p>
          ) : (
            <Select
              value={workspace ?? ""}
              onValueChange={(next) => {
                if (next) onWorkspaceChange(next);
              }}
            >
              <SelectTrigger
                aria-labelledby={workspaceLabelId}
                data-testid="create-agent-runner-workspace"
              >
                <SelectValue placeholder="Choose a workspace" />
              </SelectTrigger>
              <SelectContent>
                {selected.workspaces.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      ) : null}
    </div>
  );
}
