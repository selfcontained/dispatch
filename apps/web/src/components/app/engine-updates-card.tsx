import {
  skipToken,
  useIsFetching,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Markdown } from "@/components/ui/markdown";
import { api, ApiError } from "@/lib/api";
import type { EngineStatus } from "@/hooks/use-engines";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsGroup } from "@/components/app/settings-layout";
import { Panel } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { LoadError } from "@/components/ui/async-boundary";
import { errorStatus, failureHint } from "@/lib/errors";
import { MAC_APP_UPDATE_QUERY_KEY } from "@/hooks/use-mac-app-update";
import type { MacAppUpdateSnapshot } from "@dispatch/shared";
import { engineStatusKey } from "@/hooks/use-engines";
import { engineScopeQuery, LOCAL_ENGINE_SCOPE } from "@/lib/engine-management";
import { runnerEnginesKey } from "@/hooks/use-runner-engines";
import type {
  EngineScope,
  EngineOperationAck,
} from "@dispatch/runner-protocol/engine-management";
import { Spinner } from "@/components/ui/spinner";

type EngineUpdates = { engines: EngineStatus[]; canManage?: boolean };
function InstallationDetails({
  engine,
}: {
  engine: EngineStatus;
}): JSX.Element {
  const source = engine.update?.source;
  const installer =
    source === "native"
      ? "Claude installer"
      : source === "npm"
        ? "npm"
        : source?.startsWith("homebrew-")
          ? "Homebrew"
          : null;
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1.5 text-body-sm text-muted-foreground hover:text-foreground">
        <ChevronRight
          className="h-3 w-3 group-data-[state=open]:rotate-90"
          aria-hidden="true"
        />
        Installation details
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 pt-2 text-body-sm text-muted-foreground">
        <p>
          {installer ? `Installed using ${installer}` : "Installer unknown"}
        </p>
        {engine.update?.packageChannel && (
          <p>Package channel: {engine.update.packageChannel}</p>
        )}
        {engine.path && <p className="break-all font-mono">{engine.path}</p>}
        {engine.update?.realPath && engine.update.realPath !== engine.path && (
          <p className="break-all">Resolved path: {engine.update.realPath}</p>
        )}
        {engine.update?.canUpdate && (
          <Markdown>{`\`\`\`sh\n${engine.update.command}\n\`\`\``}</Markdown>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
function EngineRow({
  engine,
  canManage,
  scope,
}: {
  engine: EngineStatus;
  canManage: boolean;
  scope: EngineScope;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const previousOperation = useRef<string | undefined>();
  const checking = useIsFetching({ queryKey: engineStatusKey(scope) }) > 0;
  const update = useMutation({
    onMutate: () => {
      previousOperation.current = engine.update?.operation?.id;
    },
    mutationFn: async () => {
      const { ack } = await api<{ ack: EngineOperationAck }>(
        "/api/v1/engine-management/operations",
        {
          method: "POST",
          signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({
            scope,
            operation: { type: "update", engine: engine.id },
          }),
        }
      );
      if (!ack.ok) throw new Error(ack.error);
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: engineStatusKey(scope) }),
        queryClient.invalidateQueries({ queryKey: runnerEnginesKey(scope) }),
      ]);
    },
  });
  const metadata = engine.update;
  const operation = metadata?.operation;
  const running = update.isPending || operation?.status === "running";
  const retryable =
    (operation?.status === "failed" || operation?.status === "interrupted") &&
    (!metadata?.latestVersion || metadata.available);
  const reconciled =
    operation &&
    operation.id !== previousOperation.current &&
    operation.status !== "running";
  const showRequestError = update.isError && !reconciled;
  const managed = engine.installed && canManage && metadata?.canUpdate;
  return (
    <section
      className="border-t border-border-subtle pt-2 first:border-t-0 first:pt-0"
      aria-label={engine.label}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full flex-wrap items-center gap-2 py-2 text-left text-body-md hover:text-foreground transition-colors">
          {open ? (
            <ChevronDown
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          ) : (
            <ChevronRight
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          )}
          <span className="font-medium">{engine.label}</span>
          <span className="text-muted-foreground">
            {engine.installed
              ? (engine.version ?? "Version unknown")
              : "Not installed"}
          </span>
          <span className="flex h-7 w-full items-center sm:w-72">
            {running ? (
              <Badge tone="success">Updating…</Badge>
            ) : operation?.status === "interrupted" ? (
              <Badge tone="danger">Update interrupted</Badge>
            ) : operation?.status === "failed" ? (
              <Badge tone="danger">Update failed</Badge>
            ) : metadata?.latestPending ? (
              <Skeleton
                className="h-6 w-40"
                aria-label="Checking for updates"
              />
            ) : metadata?.available ? (
              <Badge tone="info">Update available</Badge>
            ) : null}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="min-w-0 space-y-2 pt-2">
          {managed && (
            <div className="flex h-9 items-center" aria-live="polite">
              {running ||
              ((metadata?.available || retryable) &&
                !operation?.retryBlocked) ? (
                <Button
                  size="sm"
                  disabled={running || operation?.retryBlocked}
                  onClick={() => update.mutate()}
                >
                  {running
                    ? "Updating…"
                    : retryable
                      ? `Retry ${engine.label} update`
                      : `Update ${engine.label} to ${metadata?.latestVersion}`}
                </Button>
              ) : operation?.retryBlocked ? (
                <p className="text-body-md text-muted-foreground">
                  Update interrupted
                </p>
              ) : metadata?.latestPending ? (
                <Skeleton
                  className="h-9 w-60"
                  aria-label="Checking for updates"
                />
              ) : (
                <p className="text-body-md text-muted-foreground">
                  {engine.version && metadata?.latestVersion
                    ? "Up to date"
                    : "Update availability unknown"}
                </p>
              )}
            </div>
          )}
          {engine.installed && !managed && (
            <div
              className="min-h-5 text-body-md text-muted-foreground"
              aria-live="polite"
            >
              {metadata?.latestPending ? (
                <Skeleton
                  className="h-5 w-44"
                  aria-label="Checking for updates"
                />
              ) : !engine.version || !metadata?.latestVersion ? (
                "Update availability unknown"
              ) : metadata.available ? (
                `Latest version: ${metadata.latestVersion}`
              ) : (
                "Up to date"
              )}
            </div>
          )}
          {metadata?.migrationWarning && (
            <p className="text-body-md text-muted-foreground">
              {metadata.migrationWarning}
            </p>
          )}
          {(!engine.installed || !metadata?.canUpdate) && (
            <>
              <p className="text-body-md text-muted-foreground">
                {engine.installed
                  ? "Update this installation with the command below."
                  : `Install ${engine.label} with the command below, then sign in.`}
              </p>
              <Markdown>{`\`\`\`sh\n${metadata?.command ?? engine.install}\n\`\`\``}</Markdown>
            </>
          )}
          {engine.installed && metadata?.canUpdate && !canManage && (
            <p className="text-body-md text-muted-foreground">
              Sign in to Dispatch to update this CLI.
            </p>
          )}
          {showRequestError && (
            <Alert title="Couldn’t start the update." error={update.error}>
              {update.error instanceof ApiError
                ? failureHint(update.error)
                : "The update request could not be confirmed. The server may still be updating. Recheck status before retrying."}
            </Alert>
          )}
          {(showRequestError ||
            (operation && operation.status !== "succeeded")) && (
            <Button
              size="sm"
              variant="ghost"
              disabled={checking}
              onClick={() =>
                void queryClient.invalidateQueries({
                  queryKey: engineStatusKey(scope),
                })
              }
            >
              {checking ? "Checking status…" : "Recheck status"}
            </Button>
          )}
          {(operation || update.isPending) && (
            <div role="status" className="space-y-2 text-body-md">
              <p>
                {update.isPending && operation?.status !== "running"
                  ? "Starting update…"
                  : operation?.message}
              </p>
              {operation?.output && (
                <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-muted p-3 text-body-sm">
                  {operation.output}
                </pre>
              )}
            </div>
          )}
          {engine.installed && <InstallationDetails engine={engine} />}
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
/**
 * How long an unreachable server reads as a reconnect rather than a failure.
 * A dropped phone connection or a quick server restart recovers within a few
 * polls; installing a Mac app update restarts Dispatch, which takes longer.
 */
export const RECONNECT_GRACE_MS = 15_000;
export const RESTART_GRACE_MS = 180_000;

/** fetch rejected (no answer) or a proxy/gateway answered for a down server. */
function isUnreachable(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const status = errorStatus(error);
  return status === 502 || status === 503 || status === 504;
}

export type EnginesLoadState = "ok" | "reconnecting" | "restarting" | "failed";

/**
 * One state for the Engines panel. A server that stopped answering is
 * "reconnecting" (or "restarting" while an update restarts it) until the
 * grace runs out; any other error, or an outage past the grace, has failed.
 */
export function enginesLoadState({
  isError,
  error,
  failingSince,
  now,
  restartExpected,
}: {
  isError: boolean;
  error: unknown;
  failingSince: number | null;
  now: number;
  restartExpected: boolean;
}): EnginesLoadState {
  if (!isError) return "ok";
  if (!isUnreachable(error) || failingSince === null) return "failed";
  const grace = restartExpected ? RESTART_GRACE_MS : RECONNECT_GRACE_MS;
  if (now - failingSince >= grace) return "failed";
  return restartExpected ? "restarting" : "reconnecting";
}

export function EngineUpdatesCard({
  scope = LOCAL_ENGINE_SCOPE,
}: { scope?: EngineScope } = {}): JSX.Element {
  const query = useQuery<EngineUpdates>({
    queryKey: engineStatusKey(scope),
    queryFn: () =>
      api(`/api/v1/engine-management/status?${engineScopeQuery(scope)}`),
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.engines.some(
        (engine) =>
          engine.update?.latestPending ||
          engine.update?.operation?.status === "running" ||
          engine.update?.operation?.retryBlocked
      )
        ? 1_000
        : 5_000,
  });
  // Read what the Mac app card already fetched; servers without the Mac app
  // have no such route, so this never fetches on its own.
  const macApp = useQuery<MacAppUpdateSnapshot>({
    queryKey: MAC_APP_UPDATE_QUERY_KEY,
    queryFn: skipToken,
  });
  const restartExpected =
    macApp.data?.connected === true &&
    macApp.data.state?.phase === "installing";

  // When the current run of failures began; cleared by the next success.
  const [failingSince, setFailingSince] = useState<number | null>(null);
  const { isError, isSuccess, errorUpdatedAt } = query;
  useEffect(() => {
    if (isError) setFailingSince((since) => since ?? errorUpdatedAt);
    else if (isSuccess) setFailingSince(null);
  }, [isError, isSuccess, errorUpdatedAt]);

  const loadState = enginesLoadState({
    isError,
    error: query.error,
    failingSince: isError ? (failingSince ?? errorUpdatedAt) : null,
    now: Date.now(),
    restartExpected,
  });

  // Re-render when the grace runs out, even if no poll lands then.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (loadState !== "reconnecting" && loadState !== "restarting") return;
    const since = failingSince ?? errorUpdatedAt;
    const grace = restartExpected ? RESTART_GRACE_MS : RECONNECT_GRACE_MS;
    const timer = setTimeout(
      () => setTick((tick) => tick + 1),
      Math.max(0, since + grace - Date.now()) + 50
    );
    return () => clearTimeout(timer);
  }, [loadState, failingSince, errorUpdatedAt, restartExpected]);

  // Background polls keep fetching; only a click spins the Retry button.
  const [retrying, setRetrying] = useState(false);
  const retry = (): void => {
    setRetrying(true);
    void query.refetch().finally(() => setRetrying(false));
  };

  const waiting = loadState === "reconnecting" || loadState === "restarting";
  return (
    <SettingsGroup
      title="Engines"
      description="Updates apply to new launches and restarts. Existing agents keep their current binary."
    >
      <Panel className="space-y-2">
        {waiting && (
          <p
            role="status"
            className="flex items-center gap-2 text-body-sm text-muted-foreground"
          >
            <Spinner className="shrink-0" />
            {loadState === "restarting"
              ? "Dispatch is restarting to finish the update. Engines refresh when it’s back."
              : "Reconnecting to Dispatch…"}
          </p>
        )}
        {(query.isPending || (waiting && !query.data)) && (
          <div
            aria-label="Checking engine installations"
            aria-busy="true"
            className="space-y-4"
          >
            {[0, 1, 2].map((row) => (
              <div
                key={row}
                className="border-t border-border-subtle pt-2 first:border-t-0 first:pt-0"
              >
                <div className="flex flex-wrap items-center gap-2 py-2">
                  <Skeleton className="h-5 w-48" />
                  <span className="flex h-7 w-full items-center sm:w-72">
                    <Skeleton className="h-6 w-40" />
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
        {loadState === "failed" && (
          <LoadError
            thing="engines"
            error={query.error}
            retrying={retrying}
            onRetry={retry}
          />
        )}
        {query.data?.engines.map((engine) => (
          <EngineRow
            key={engine.id}
            engine={engine}
            scope={scope}
            canManage={query.data?.canManage === true}
          />
        ))}
      </Panel>
    </SettingsGroup>
  );
}
