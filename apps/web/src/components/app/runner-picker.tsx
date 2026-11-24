import { Server } from "lucide-react";
import { useId } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { LaunchTarget } from "@/hooks/use-launch-targets";
import { cn } from "@/lib/utils";

/** One machine in the picker: what kind it is, its name, whether it is up. */
function RunnerOption({
  name,
  status,
}: {
  name: string;
  status: "online" | "offline" | "pending" | "unavailable";
}) {
  const Icon = Server;
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
                : "bg-muted-foreground/line-strong"
        )}
      />
    </span>
  );
}

/** "Runs on" picker: This computer by default, or a paired runner. */
export function RunnerPicker({
  targets,
  value,
  onChange,
}: {
  targets: LaunchTarget[];
  value?: string;
  onChange: (key: string) => void;
}): JSX.Element | null {
  const runnerLabelId = useId();
  if (targets.length < 2) return null;
  return (
    <div className="w-44 shrink-0" data-testid="runner-picker">
      <div className="space-y-1">
        <label id={runnerLabelId} className="sr-only">
          Runs on
        </label>
        <Select
          value={value ?? ""}
          onValueChange={(key) => {
            if (key) onChange(key);
          }}
        >
          <SelectTrigger
            aria-labelledby={runnerLabelId}
            className="h-8 gap-1.5 px-2 text-body-sm [&>span]:min-w-0 [&>span]:flex-1"
            data-testid="create-agent-runner"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end" className="min-w-48">
            {targets.map((target) => (
              <SelectItem
                key={target.key}
                value={target.key}
                data-testid={`create-agent-runner-option-${target.key}`}
              >
                <RunnerOption
                  name={target.name}
                  status={target.status as "online" | "offline" | "pending"}
                />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
