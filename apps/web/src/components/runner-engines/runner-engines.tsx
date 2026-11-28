import { RunnerPlugin } from "./runner-plugin";
import { useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";

import type { EngineInventoryEntry } from "@dispatch/runner-protocol/engine-management";

import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { LoadingButton } from "@/components/ui/button";
import { EngineSignIn } from "@/components/app/engine-sign-in";
import {
  useRunnerEngineInventory,
  useRunnerEngineOperation,
} from "@/hooks/use-runner-engines";
import type { EngineScope } from "@dispatch/runner-protocol/engine-management";

/**
 * Engine install/update/sign-in for one scope: this machine, or a named
 * runner workspace. Self-contained — the caller only supplies `scope`
 * (and, for a runner, the surrounding "which runner/workspace" picker).
 * See `use-runner-engines.ts` for the HTTP contract this expects.
 */
export function RunnerEngines({
  scope,
  capabilities = false,
  updating = false,
}: {
  scope: EngineScope;
  capabilities?: boolean;
  updating?: boolean;
}): JSX.Element {
  const inventory = useRunnerEngineInventory(scope);
  const entries = inventory.data?.entries ?? [];

  if (
    inventory.isLoading ||
    (updating && !inventory.isError && inventory.data?.entries === null)
  ) {
    return (
      <p
        role="status"
        className="flex items-center gap-2 text-body-md text-muted-foreground"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Loading engines…
      </p>
    );
  }

  if (inventory.isError) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p role="alert" className="text-body-md text-danger">
          Could not load engines.
        </p>
        <LoadingButton
          type="button"
          variant="ghost"
          size="sm"
          loading={inventory.isFetching}
          onClick={() => void inventory.refetch()}
        >
          Try again
        </LoadingButton>
      </div>
    );
  }

  return (
    <div
      className="divide-y divide-border rounded-md border border-border px-3"
      data-testid="runner-engines"
    >
      {entries.length === 0 && (
        <p className="py-3 text-body-md text-muted-foreground">
          No engines reported.
        </p>
      )}
      {entries.map((entry) => (
        <EngineRow
          key={entry.id}
          scope={scope}
          entry={entry}
          capabilities={capabilities}
        />
      ))}
    </div>
  );
}

function EngineRow({
  scope,
  entry,
  capabilities,
}: {
  scope: EngineScope;
  entry: EngineInventoryEntry;
  capabilities: boolean;
}): JSX.Element {
  const operation = useRunnerEngineOperation(scope);
  const [actionResult, setActionResult] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);

  const run = (
    op: Parameters<ReturnType<typeof useRunnerEngineOperation>["mutate"]>[0]
  ) => {
    setActionResult(null);
    operation.mutate(op, {
      onSuccess: ({ ack }) => {
        if (!ack.ok || op.type === "install" || op.type === "update") {
          setActionResult(
            ack.ok
              ? { kind: "success", message: ack.message ?? "Done." }
              : { kind: "error", message: ack.error }
          );
        }
      },
    });
  };

  const pendingAction = operation.isPending
    ? operation.variables?.type
    : undefined;
  const canInstall = entry.actions.includes("install");
  const canUpdate = entry.actions.includes("update");
  const canLogin = entry.actions.includes("login");

  return (
    <div
      className="min-w-0 space-y-2 py-3"
      data-testid={`runner-engine-${entry.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true">
            <AgentTypeIcon
              type={entry.id}
              className="size-9 rounded-lg [&_svg]:size-5"
            />
          </span>
          <div className="min-w-0">
            <div className="text-body-md font-medium">{entry.label}</div>
            <p className="mt-0.5 break-words text-body-sm text-muted-foreground">
              {entry.installed ? (
                <>
                  {entry.version ? `v${entry.version}` : "Installed"}
                  {entry.signedIn === true && " · signed in"}
                  {entry.signedIn === false && " · signed out"}
                  {entry.detail && entry.signedIn && ` · ${entry.detail}`}
                </>
              ) : entry.issue === "install-unavailable" ? (
                (entry.detail ?? "Install unavailable")
              ) : (
                "Not installed"
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canInstall && (
            <LoadingButton
              type="button"
              size="xs"
              disabled={operation.isPending}
              loading={pendingAction === "install"}
              onClick={() => run({ type: "install", engine: entry.id })}
              data-testid={`runner-engine-${entry.id}-install`}
            >
              {pendingAction === "install" ? "Installing…" : "Install"}
            </LoadingButton>
          )}
          {canUpdate && (
            <LoadingButton
              type="button"
              size="xs"
              disabled={operation.isPending}
              loading={pendingAction === "update"}
              onClick={() => run({ type: "update", engine: entry.id })}
              data-testid={`runner-engine-${entry.id}-update`}
            >
              {pendingAction === "update" ? "Updating…" : "Update"}
            </LoadingButton>
          )}
          {canLogin && entry.signedIn !== true && entry.id !== "opencode" && (
            <EngineSignIn engine={entry.id} scope={scope} />
          )}
        </div>
      </div>

      {capabilities && entry.installed && entry.id !== "opencode" && (
        <RunnerPlugin scope={scope} engine={entry.id} />
      )}

      {operation.isError && (
        <p role="alert" className="text-body-sm text-danger">
          {operation.error.message}
        </p>
      )}

      {actionResult?.kind === "error" && (
        <p
          role="alert"
          className="text-body-sm text-danger"
          data-testid={`runner-engine-${entry.id}-action-error`}
        >
          {actionResult.message}
        </p>
      )}
      {actionResult?.kind === "success" && (
        <p
          className="flex items-center gap-2 text-body-sm text-foreground"
          data-testid={`runner-engine-${entry.id}-action-success`}
        >
          <CheckCircle2
            className="h-3.5 w-3.5 text-status-working"
            aria-hidden="true"
          />
          {actionResult.message}
        </p>
      )}
    </div>
  );
}
