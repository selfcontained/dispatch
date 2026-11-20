import { Monitor, Server } from "lucide-react";
import { useId } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type Runner } from "@/hooks/use-runners";
import { cn } from "@/lib/utils";

const THIS_COMPUTER = "__local__";

/** One machine in the picker: what kind it is, its name, whether it is up. */
function RunnerOption({
  local = false,
  name,
  status,
}: {
  local?: boolean;
  name: string;
  status: "online" | "offline" | "pending" | "unavailable";
}) {
  const Icon = local ? Monitor : Server;
  return (
    <span className="flex w-full min-w-0 items-center gap-1.5">
      <Icon
        aria-hidden="true"
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <span className="min-w-0 flex-1 truncate text-left">{name}</span>
      <span
        role="img"
        aria-label={status}
        title={status}
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          status === "online"
            ? "bg-status-working"
            : status === "pending"
              ? "bg-status-waiting"
              : status === "unavailable"
                ? "bg-status-blocked"
                : "bg-muted-foreground/50"
        )}
      />
    </span>
  );
}

/** "Runs on" picker: This computer by default, or a paired runner + workspace. */
export function RunnerPicker({
  runners,
  runnerId,
  onRunnerChange,
  unavailable,
}: {
  runners: Runner[];
  runnerId: string | null;
  onRunnerChange: (id: string | null) => void;
  unavailable: boolean;
}): JSX.Element | null {
  const runnerLabelId = useId();
  const usable = runners.filter((r) => r.status !== "revoked");
  if (usable.length === 0 && !runnerId) return null;
  return (
    <div className="w-44 shrink-0" data-testid="runner-picker">
      <div className="space-y-1">
        <label id={runnerLabelId} className="sr-only">
          Runs on
        </label>
        <Select
          value={runnerId ?? THIS_COMPUTER}
          onValueChange={(next) => {
            if (next) onRunnerChange(next === THIS_COMPUTER ? null : next);
          }}
        >
          <SelectTrigger
            aria-labelledby={runnerLabelId}
            className="h-8 gap-1.5 px-2 text-xs [&>span]:min-w-0 [&>span]:flex-1"
            data-testid="create-agent-runner"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end" className="min-w-48">
            <SelectItem value={THIS_COMPUTER}>
              <RunnerOption local name="This computer" status="online" />
            </SelectItem>
            {unavailable && runnerId ? (
              <SelectItem value={runnerId} disabled>
                <RunnerOption
                  name={
                    runners.find((r) => r.id === runnerId)?.name ?? "Runner"
                  }
                  status="unavailable"
                />
              </SelectItem>
            ) : null}
            {usable.map((runner) => (
              <SelectItem
                key={runner.id}
                value={runner.id}
                disabled={runner.status !== "online"}
                data-testid={`create-agent-runner-option-${runner.id}`}
              >
                <RunnerOption
                  name={runner.name}
                  status={
                    runner.status === "revoked" ? "offline" : runner.status
                  }
                />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

export function RunnerWorkspacePicker({
  selected,
  workspace,
  onWorkspaceChange,
}: {
  selected: Runner;
  workspace: string | null;
  onWorkspaceChange: (workspace: string) => void;
}) {
  const workspaceLabelId = useId();
  return (
    <div className="space-y-1">
      <label id={workspaceLabelId} className="text-sm text-muted-foreground">
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
  );
}
