import { RunnerProviderUsage } from "@/components/runner-engines/runner-provider-usage";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, Ellipsis, Server } from "lucide-react";
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RunnerEngines } from "@/components/runner-engines/runner-engines";
import { useEnginesRefreshAfterUpdate } from "@/hooks/use-runner-engines";
import {
  runnersQueryKey,
  useRunnerMutations,
  useRunners,
  useWantedBuildRefresh,
  type Runner,
  type RunnerStatus,
} from "@/hooks/use-runners";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { RunnerGitHubAccount } from "./runner-github-account";
import { isRunnerHealthFresh, RunnerHealthDetails } from "./runner-health";
import { RunnerOnboarding, RunnerPairingRequests } from "./runner-onboarding";
import { RunnerUpdateStatus } from "./runner-update";

const STATUS_LABEL: Record<RunnerStatus, string> = {
  pending: "Waiting to pair",
  online: "Online",
  offline: "Offline",
  revoked: "Revoked",
};

const STATUS_DOT: Record<RunnerStatus, string> = {
  pending: "bg-status-waiting",
  online: "bg-status-working",
  offline: "bg-muted-foreground/60",
  revoked: "bg-destructive",
};

function RunnerStatusLabel({
  runner,
  checkedAt,
}: {
  runner: Runner;
  checkedAt?: number;
}) {
  const health =
    checkedAt !== undefined && isRunnerHealthFresh(runner, checkedAt)
      ? runner.health
      : undefined;
  return (
    <span className="inline-flex max-w-full items-baseline gap-1.5 whitespace-normal text-xs text-muted-foreground">
      <span
        className={cn(
          "size-1.5 shrink-0 self-start rounded-full mt-[5px]",
          STATUS_DOT[runner.status]
        )}
        aria-hidden="true"
      />
      <span>
        <span data-testid={`runner-status-${runner.id}`}>
          {STATUS_LABEL[runner.status]}
        </span>
        {health && (
          <span>
            {" · "}
            {health.working > 0
              ? `${health.working} working`
              : `${health.sessions} ${health.sessions === 1 ? "session" : "sessions"}`}
          </span>
        )}
      </span>
    </span>
  );
}

export function RunnerSettings(): JSX.Element {
  const runners = useRunners({ poll: true });
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [notice, setNotice] = useState("");
  const queryClient = useQueryClient();
  const clearRevoked = useMutation({
    mutationFn: (ids: string[]) =>
      api<{ cleared: number }>("/api/runners/revoked/clear", {
        method: "POST",
        body: JSON.stringify({ ids }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: runnersQueryKey });
      setNotice("Revoked runners cleared.");
      heading.current?.focus();
    },
  });
  const heading = useRef<HTMLHeadingElement>(null);
  const previousRunner = useRef<string | null>(null);
  const selectedId = params.get("runner");
  const inDetail = selectedId !== null;
  const listParams = new URLSearchParams(params);
  listParams.delete("runner");
  const listSearch = listParams.toString();
  const roster = (runners.data ?? []).filter(
    (runner) => runner.status !== "revoked"
  );
  const history = (runners.data ?? []).filter(
    (runner) => runner.status === "revoked"
  );
  const selected = roster.find((runner) => runner.id === selectedId);
  const loading = runners.isPending;
  const loadFailed = runners.isError && !runners.data;
  const checkedAt = Math.max(runners.dataUpdatedAt, runners.errorUpdatedAt);

  useEffect(() => {
    if (selectedId !== null) {
      previousRunner.current = selectedId;
      if (!loading) heading.current?.focus();
    } else if (previousRunner.current !== null) {
      const row = document.getElementById(
        `runner-select-${encodeURIComponent(previousRunner.current)}`
      );
      (row ?? heading.current)?.focus();
      previousRunner.current = null;
    }
  }, [selectedId, selected?.id, loading, loadFailed]);

  function backToList() {
    if (location.state?.runnerListSearch === listSearch) {
      navigate(-1);
    } else {
      setParams(listParams, { replace: true });
    }
  }

  function onRevoked(runner: Runner) {
    setNotice(`Access revoked for ${runner.name}.`);
    setParams(listParams, { replace: true });
  }

  return (
    <section
      aria-labelledby="runner-settings-heading"
      data-testid="runner-settings"
      className="mx-auto w-full min-w-0 max-w-4xl space-y-4 p-4 md:p-6"
    >
      {inDetail ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="-ml-2 gap-1.5"
          onClick={backToList}
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to runners
        </Button>
      ) : (
        <header className="flex items-center justify-between gap-3">
          <h2
            id="runner-settings-heading"
            tabIndex={-1}
            ref={heading}
            className="text-xl font-semibold focus:outline-none"
          >
            Runners
          </h2>
          <RunnerOnboarding />
        </header>
      )}

      {!inDetail && (
        <>
          <RunnerPairingRequests />
          <p
            role="status"
            className={cn(
              "text-sm text-muted-foreground",
              !notice && "sr-only"
            )}
          >
            {notice}
          </p>
        </>
      )}

      {inDetail && !selected && (
        <h2
          id="runner-settings-heading"
          tabIndex={-1}
          ref={heading}
          className="text-xl font-semibold focus:outline-none"
        >
          {loading || loadFailed ? "Runner details" : "Runner unavailable"}
        </h2>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading runners…
        </p>
      ) : loadFailed ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-destructive" role="alert">
            Could not load runners.
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void runners.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : inDetail ? (
        selected ? (
          <RunnerDetail
            key={selected.id}
            runner={selected}
            heading={heading}
            onRevoked={() => onRevoked(selected)}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            This runner is no longer connected.
          </p>
        )
      ) : (
        <>
          {roster.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No connected runners.
            </p>
          ) : (
            <ul
              className="divide-y divide-border rounded-md border border-border"
              data-testid="runner-list"
            >
              {roster.map((runner) => {
                const next = new URLSearchParams(listParams);
                next.set("runner", runner.id);
                return (
                  <li
                    key={runner.id}
                    data-testid={`runner-${runner.id}`}
                    data-status={runner.status}
                  >
                    <Button
                      variant="ghost"
                      asChild
                      className="h-auto min-h-12 w-full justify-start gap-3 px-3 py-2.5 text-left text-foreground"
                    >
                      <Link
                        id={`runner-select-${encodeURIComponent(runner.id)}`}
                        data-testid={`runner-select-${runner.id}`}
                        to={{ search: next.toString(), hash: location.hash }}
                        state={{ runnerListSearch: listSearch }}
                        onClick={() => setNotice("")}
                      >
                        <Server
                          className="size-4 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                          <span className="max-w-full truncate">
                            {runner.name}
                          </span>
                          <RunnerStatusLabel
                            runner={runner}
                            checkedAt={checkedAt}
                          />
                        </span>
                        <ChevronRight
                          className="size-4 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                      </Link>
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}

          {history.length > 0 && (
            <details className="text-sm text-muted-foreground">
              <summary className="w-fit cursor-pointer rounded-sm py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Revoked runners ({history.length})
              </summary>
              <ul className="mt-1 divide-y divide-border">
                {history.map((runner) => (
                  <li
                    key={runner.id}
                    className="flex items-center justify-between gap-2 px-3 py-2"
                    data-testid={`runner-${runner.id}`}
                    data-status="revoked"
                  >
                    <span className="min-w-0 break-words">{runner.name}</span>
                    <RunnerStatusLabel runner={runner} />
                  </li>
                ))}
              </ul>
              <Button
                type="button"
                variant="default"
                size="sm"
                className="mt-2"
                disabled={clearRevoked.isPending}
                onClick={() => {
                  setNotice("");
                  clearRevoked.mutate(history.map((runner) => runner.id));
                }}
              >
                {clearRevoked.isPending ? "Clearing…" : "Clear revoked runners"}
              </Button>
              {clearRevoked.isError && (
                <p className="mt-2 text-sm text-destructive" role="alert">
                  {clearRevoked.error.message}
                </p>
              )}
            </details>
          )}
        </>
      )}
    </section>
  );
}

function RunnerDetail({
  runner,
  heading,
  onRevoked,
}: {
  runner: Runner;
  heading: React.RefObject<HTMLHeadingElement>;
  onRevoked: () => void;
}) {
  useWantedBuildRefresh(runner);
  useEnginesRefreshAfterUpdate(runner.id, Boolean(runner.update?.attempt));
  return (
    <div className="min-w-0 divide-y divide-border" data-testid="runner-detail">
      <header className="flex items-start justify-between gap-2 pb-4">
        <div className="min-w-0">
          <h2
            id="runner-settings-heading"
            tabIndex={-1}
            ref={heading}
            className="break-words text-xl font-semibold focus:outline-none"
          >
            {runner.name}
          </h2>
          <RunnerStatusLabel runner={runner} />
        </div>
        <RunnerConnectionActions runner={runner} onRevoked={onRevoked} />
      </header>

      <div className="py-4">
        <RunnerGitHubAccount runner={runner} />
      </div>

      <section id="runner-agent-engines" className="space-y-2 py-4">
        <h3 className="text-sm font-medium">Agent engines</h3>
        {runner.status === "online" && runner.engineCapabilities && (
          <p className="text-xs text-muted-foreground">
            Install and sign in to Claude or Codex here to see its plan limits
            below.
          </p>
        )}
        {runner.status !== "online" ? (
          <p className="text-sm text-muted-foreground">
            Available when the runner is online.
          </p>
        ) : !runner.engineManagement ? (
          <p className="text-sm text-muted-foreground">
            Engine management isn’t supported on this runner.
          </p>
        ) : (
          <>
            <RunnerEngines
              scope={{ kind: "runner", runnerId: runner.id }}
              capabilities={runner.engineCapabilities}
            />
            {runner.engineCapabilities ? (
              <RunnerProviderUsage
                key={runner.id}
                runnerId={runner.id}
                allowReset
              />
            ) : (
              <p className="text-xs text-muted-foreground">
                Update this runner to read plan limits and plugins.
              </p>
            )}
          </>
        )}
      </section>

      <div className="space-y-2 py-4">
        <RunnerUpdateStatus runner={runner} />
        <RunnerHealthDetails runner={runner} />
        {runner.workspaces.length > 0 && !runner.managedWorkspace && (
          <p className="break-words text-xs text-muted-foreground">
            Folders: {runner.workspaces.join(", ")}
          </p>
        )}
      </div>
    </div>
  );
}

function RunnerConnectionActions({
  runner,
  onRevoked,
}: {
  runner: Runner;
  onRevoked: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { revoke } = useRunnerMutations();

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Runner actions"
            ref={trigger}
            data-testid={`runner-actions-${runner.id}`}
          >
            <Ellipsis className="size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(event) => {
            if (confirmOpen) event.preventDefault();
          }}
        >
          <DropdownMenuItem
            data-testid={`runner-revoke-${runner.id}`}
            onSelect={() => {
              revoke.reset();
              setConfirmOpen(true);
            }}
          >
            Revoke connection
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!revoke.isPending) setConfirmOpen(open);
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <AlertDialogTitle className="break-words text-base font-semibold">
            Revoke access for {runner.name}?
          </AlertDialogTitle>
          <AlertDialogDescription className="text-sm text-muted-foreground">
            This disconnects the runner and blocks new sessions on it. To
            reconnect it, pair it again.
          </AlertDialogDescription>
          {revoke.isError && (
            <p className="text-sm text-destructive" role="alert">
              {revoke.error.message}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <AlertDialogCancel disabled={revoke.isPending}>
              Cancel
            </AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={revoke.isPending}
              aria-label={`Confirm revoke ${runner.name}`}
              data-testid={`runner-revoke-confirm-${runner.id}`}
              onClick={() =>
                void revoke.mutateAsync(runner.id).then(onRevoked, () => {
                  // The dialog displays the mutation error.
                })
              }
            >
              {revoke.isPending ? "Revoking…" : "Revoke access"}
            </Button>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
