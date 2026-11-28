import type { EngineScope } from "@dispatch/runner-protocol/engine-management";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { LoadingButton } from "@/components/ui/button";
import { runnerEngineCapability } from "@/hooks/use-runner-engines";

export function RunnerPlugin({
  scope,
  engine,
}: {
  scope: EngineScope;
  engine: "codex" | "claude";
}) {
  const client = useQueryClient();
  const queryKey = [
    "runner-plugin",
    scope.kind === "local" ? "local" : scope.runnerId,
    engine,
  ];
  const plugin = "dispatch@dispatch";
  const status = useQuery({
    queryKey,
    retry: false,
    queryFn: async () =>
      (
        await runnerEngineCapability(
          scope,
          { type: "plugin_status", engine, plugin },
          "plugin_status"
        )
      ).status,
  });
  const change = useMutation({
    mutationFn: async (action: "install" | "update") =>
      (
        await runnerEngineCapability(
          scope,
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
    <div className="flex flex-wrap items-center gap-2 text-body-sm">
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
        <LoadingButton
          size="sm"
          loading={change.isPending || status.isFetching}
          onClick={() => change.mutate(action)}
        >
          {change.isPending
            ? action === "install"
              ? "Installing plugin…"
              : "Updating plugin…"
            : status.isFetching
              ? "Checking plugin…"
              : action === "install"
                ? "Install plugin"
                : "Update plugin"}
        </LoadingButton>
      )}
      {status.isError && (
        <LoadingButton
          size="sm"
          variant="ghost"
          loading={status.isFetching}
          onClick={() => void status.refetch()}
        >
          Retry plugin status
        </LoadingButton>
      )}
      {change.isError && <span role="alert">{change.error.message}</span>}
    </div>
  );
}
