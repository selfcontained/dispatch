import type { EngineScope } from "@dispatch/runner-protocol/engine-management";

import { LoadingButton } from "@/components/ui/button";
import { usePluginStatus, useUpdatePlugin } from "@/hooks/use-plugin-status";

export function RunnerPlugin({
  scope,
  engine,
}: {
  scope: EngineScope;
  engine: "codex" | "claude";
}) {
  const status = usePluginStatus(scope);
  const current = status.data?.statuses.find(
    (item) => item.agentType === engine
  );
  const change = useUpdatePlugin(
    current?.installed ? "update" : "install",
    scope
  );
  if (status.data && !current) return null;
  const action = current?.installed ? "update" : "install";
  const offered =
    current &&
    !current.detectionError &&
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
          onClick={() => change.mutate(engine)}
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
