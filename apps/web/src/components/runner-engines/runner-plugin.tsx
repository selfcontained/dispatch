import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { runnerEngineCapability } from "@/hooks/use-runner-engines";

export function RunnerPlugin({
  runnerId,
  engine,
}: {
  runnerId: string;
  engine: "codex" | "claude";
}) {
  const client = useQueryClient();
  const queryKey = ["runner-plugin", runnerId, engine];
  const plugin = "dispatch@dispatch";
  const status = useQuery({
    queryKey,
    retry: false,
    queryFn: async () =>
      (
        await runnerEngineCapability(
          runnerId,
          { type: "plugin_status", engine, plugin },
          "plugin_status"
        )
      ).status,
  });
  const change = useMutation({
    mutationFn: async (action: "install" | "update") =>
      (
        await runnerEngineCapability(
          runnerId,
          {
            type: action === "install" ? "plugin_install" : "plugin_update",
            engine,
            plugin,
          },
          "plugin_status"
        )
      ).status,
    onSuccess: (data) => client.setQueryData(queryKey, data),
    onError: () => client.invalidateQueries({ queryKey }),
  });
  const current = status.data;
  const action = current?.installed ? "update" : "install";
  const offered =
    current?.actions.includes(action) &&
    (action === "install" || current.updateAvailable);

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span>
        Dispatch plugin ·{" "}
        {status.isError
          ? status.error.message
          : current
            ? current.installed
              ? [
                  current.currentVersion ?? "installed",
                  current.enabled ? null : "disabled",
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "not installed"
            : "checking…"}
      </span>
      {offered && !status.isError && (
        <Button
          size="sm"
          variant="default"
          disabled={status.isFetching || change.isPending}
          onClick={() => change.mutate(action)}
        >
          {action === "install" ? "Install plugin" : "Update plugin"}
        </Button>
      )}
      {status.isError && (
        <Button size="sm" variant="ghost" onClick={() => void status.refetch()}>
          Retry plugin status
        </Button>
      )}
      {change.isError && <span role="alert">{change.error.message}</span>}
    </div>
  );
}
