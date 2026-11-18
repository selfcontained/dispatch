import { RunnerEngines } from "@/components/runner-engines/runner-engines";
import { RunnerHealthDetails } from "./runner-health";
import { useState } from "react";
import { Server, Unplug } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { RunnerOnboarding } from "./runner-onboarding";
import {
  useRunnerMutations,
  useRunners,
  type RunnerStatus,
} from "@/hooks/use-runners";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<RunnerStatus, string> = {
  pending: "Waiting to pair",
  online: "Online",
  offline: "Offline",
  revoked: "Revoked",
};

const STATUS_DOT: Record<RunnerStatus, string> = {
  pending: "bg-amber-400",
  online: "bg-emerald-500",
  offline: "bg-muted-foreground/60",
  revoked: "bg-destructive",
};

export function RunnerSettings(): JSX.Element {
  const runners = useRunners({ poll: true });
  const { revoke } = useRunnerMutations();
  const [expandedEngines, setExpandedEngines] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const list = runners.data ?? [];

  return (
    <Card data-testid="runner-settings">
      <CardHeader>
        <CardTitle className="text-base">Remote runners</CardTitle>
        <CardDescription>
          Run agents on another machine. Pair a runner, then pick it in Create
          Agent. Local agents keep working if a runner disconnects.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <RunnerOnboarding />

        {runners.isPending ? (
          <p className="text-sm text-muted-foreground" role="status">
            Loading runners...
          </p>
        ) : runners.isError ? (
          <div className="space-y-2">
            <p className="text-sm text-destructive" role="alert">
              Could not load runners.
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="border border-border"
              onClick={() => void runners.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : list.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
            No runners yet. Agents run on this Mac.
          </p>
        ) : (
          <ul className="space-y-2" data-testid="runner-list">
            {list.map((runner) => (
              <li
                key={runner.id}
                className="flex flex-col gap-2 rounded-md border border-border bg-background/50 px-3 py-3 sm:flex-row sm:items-center"
                data-testid={`runner-${runner.id}`}
                data-status={runner.status}
              >
                <Server
                  className="hidden h-4 w-4 shrink-0 text-muted-foreground sm:block"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium">
                      {runner.name}
                    </p>
                    <Badge
                      variant="default"
                      className="gap-1.5 normal-case tracking-normal"
                      data-testid={`runner-status-${runner.id}`}
                    >
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          STATUS_DOT[runner.status]
                        )}
                        aria-hidden="true"
                      />
                      {STATUS_LABEL[runner.status]}
                    </Badge>
                  </div>
                  <RunnerHealthDetails runner={runner} />
                  {runner.status === "online" && runner.engineManagement && (
                    <div className="mt-1 space-y-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-1 text-xs"
                        aria-expanded={expandedEngines === runner.id}
                        aria-label={`Manage engines on ${runner.name}`}
                        onClick={() =>
                          setExpandedEngines(
                            expandedEngines === runner.id ? null : runner.id
                          )
                        }
                      >
                        Manage engines
                      </Button>
                      {expandedEngines === runner.id && (
                        <RunnerEngines
                          scope={{
                            kind: "runner",
                            runnerId: runner.id,
                            workspace: runner.workspaces[0] ?? "",
                          }}
                        />
                      )}
                    </div>
                  )}
                  {runner.workspaces.length > 0 && !runner.managedWorkspace && (
                    <p className="mt-0.5 break-words text-xs text-muted-foreground">
                      Folders: {runner.workspaces.join(", ")}
                    </p>
                  )}
                </div>
                {runner.status !== "revoked" &&
                  (confirmId === runner.id ? (
                    <div className="flex shrink-0 gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        disabled={revoke.isPending}
                        aria-label={`Confirm revoke ${runner.name}`}
                        onClick={() =>
                          revoke.mutate(runner.id, {
                            onSettled: () => setConfirmId(null),
                          })
                        }
                        data-testid={`runner-revoke-confirm-${runner.id}`}
                      >
                        Revoke access
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmId(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="shrink-0 gap-1.5 self-start text-destructive hover:text-destructive sm:self-center"
                      aria-label={`Revoke ${runner.name}`}
                      onClick={() => setConfirmId(runner.id)}
                      data-testid={`runner-revoke-${runner.id}`}
                    >
                      <Unplug className="h-3.5 w-3.5" aria-hidden="true" />
                      Revoke
                    </Button>
                  ))}
              </li>
            ))}
          </ul>
        )}
        {revoke.isError && (
          <p className="text-sm text-destructive" role="alert">
            Could not revoke that runner. Try again.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
