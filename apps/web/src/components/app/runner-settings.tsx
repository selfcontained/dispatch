import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Server } from "lucide-react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { RunnerEngines } from "@/components/runner-engines/runner-engines";
import {
  useRunnerMutations,
  useRunners,
  type Runner,
  type RunnerStatus,
} from "@/hooks/use-runners";
import { cn } from "@/lib/utils";
import { RunnerGitHubAccount } from "./runner-github-account";
import { RunnerHealthDetails } from "./runner-health";
import { RunnerOnboarding, RunnerPairingRequests } from "./runner-onboarding";

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
  inRoster,
}: {
  runner: Runner;
  inRoster?: boolean;
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
      data-testid={inRoster ? `runner-status-${runner.id}` : undefined}
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          STATUS_DOT[runner.status]
        )}
        aria-hidden="true"
      />
      {STATUS_LABEL[runner.status]}
    </span>
  );
}

export function RunnerSettings(): JSX.Element {
  const runners = useRunners({ poll: true });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const rosterHeading = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const roster = (runners.data ?? []).filter(
    (runner) => runner.status !== "revoked"
  );
  const history = (runners.data ?? []).filter(
    (runner) => runner.status === "revoked"
  );
  const selected = roster.find((runner) => runner.id === selectedId);

  useEffect(() => {
    const row = returnFocus.current;
    if (selectedId || !row) return;
    (row.isConnected ? row : rosterHeading.current)?.focus();
    returnFocus.current = null;
  }, [selectedId]);

  return (
    <section
      aria-labelledby="remote-runners-heading"
      data-testid="runner-settings"
      className="[container-type:inline-size] space-y-4 border-t border-border pt-6"
    >
      <header className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id="remote-runners-heading" className="text-lg font-semibold">
            Remote runners
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect a machine to run agents there from Dispatch.
          </p>
        </div>
        <RunnerOnboarding />
      </header>

      <RunnerPairingRequests />
      <p
        role="status"
        className={cn("text-sm text-muted-foreground", !notice && "sr-only")}
      >
        {notice}
      </p>

      {runners.isPending ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading runners…
        </p>
      ) : runners.isError && !runners.data ? (
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
      ) : (
        <div
          className={cn(
            roster.length > 0 &&
              "[@container(min-width:36rem)]:grid [@container(min-width:36rem)]:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] [@container(min-width:36rem)]:items-start [@container(min-width:36rem)]:gap-5"
          )}
        >
          <div
            className={cn(
              "min-w-0 space-y-2",
              selected && "hidden [@container(min-width:36rem)]:block"
            )}
          >
            <h3
              ref={rosterHeading}
              tabIndex={-1}
              className="text-sm font-medium focus:outline-none"
            >
              Runners
            </h3>
            {roster.length === 0 ? (
              <p className="rounded-md bg-muted/35 px-3 py-4 text-sm text-muted-foreground">
                No connected runners. Agents run on this machine by default.
              </p>
            ) : (
              <ul className="space-y-1" data-testid="runner-list">
                {roster.map((runner) => (
                  <li
                    key={runner.id}
                    data-testid={`runner-${runner.id}`}
                    data-status={runner.status}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      data-testid={`runner-select-${runner.id}`}
                      aria-current={selected?.id === runner.id || undefined}
                      className={cn(
                        "h-auto min-h-12 w-full justify-start gap-2.5 px-3 py-2 text-left text-foreground",
                        selected?.id === runner.id && "bg-muted"
                      )}
                      onClick={(event) => {
                        returnFocus.current = event.currentTarget;
                        setNotice("");
                        setSelectedId(runner.id);
                      }}
                    >
                      <Server
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                        <span className="max-w-full truncate">
                          {runner.name}
                        </span>
                        <RunnerStatusLabel runner={runner} inRoster />
                      </span>
                      <ChevronRight
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {history.length > 0 && (
              <details className="border-t border-border pt-2 text-sm text-muted-foreground">
                <summary className="w-fit cursor-pointer rounded-sm py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  Revoked runners ({history.length})
                </summary>
                <ul className="mt-1 divide-y divide-border pl-3">
                  {history.map((runner) => (
                    <li
                      key={runner.id}
                      className="flex items-center justify-between gap-2 py-2"
                      data-testid={`runner-${runner.id}`}
                      data-status="revoked"
                    >
                      <span className="min-w-0 break-words">{runner.name}</span>
                      <RunnerStatusLabel runner={runner} inRoster />
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
          {selected ? (
            <RunnerDetail
              key={selected.id}
              runner={selected}
              onBack={() => setSelectedId(null)}
              onRevoked={() => {
                setNotice(`Access revoked for ${selected.name}.`);
                setSelectedId(null);
              }}
            />
          ) : roster.length > 0 ? (
            <p className="hidden border-l border-border px-5 py-3 text-sm text-muted-foreground [@container(min-width:36rem)]:block">
              Select a runner to view its details.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

function RunnerDetail({
  runner,
  onBack,
  onRevoked,
}: {
  runner: Runner;
  onBack: () => void;
  onRevoked: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [enginesOpen, setEnginesOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { revoke } = useRunnerMutations();

  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <section
      aria-labelledby="runner-detail-heading"
      className="min-w-0 divide-y divide-border [@container(min-width:36rem)]:border-l [@container(min-width:36rem)]:pl-5"
      data-testid="runner-detail"
    >
      <div className="space-y-2 pb-3">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="-ml-2 gap-1.5 [@container(min-width:36rem)]:hidden"
          onClick={onBack}
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to runners
        </Button>
        <div>
          <h3
            id="runner-detail-heading"
            tabIndex={-1}
            ref={heading}
            className="break-words text-base font-semibold focus:outline-none"
          >
            {runner.name}
          </h3>
          <RunnerStatusLabel runner={runner} />
        </div>
        {runner.workspaces.length > 0 && !runner.managedWorkspace && (
          <p className="break-words text-xs text-muted-foreground">
            Folders: {runner.workspaces.join(", ")}
          </p>
        )}
      </div>

      <section className="space-y-2 py-3">
        <h4 className="text-sm font-medium">Health</h4>
        <RunnerHealthDetails runner={runner} />
      </section>

      <div className="py-3">
        <RunnerGitHubAccount runner={runner} />
      </div>

      <section className="space-y-2 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-medium">Agent engines</h4>
          {runner.status === "online" && runner.engineManagement && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={enginesOpen}
              aria-controls="runner-engine-management"
              onClick={() => setEnginesOpen((open) => !open)}
            >
              {enginesOpen ? "Hide engines" : "Manage engines"}
            </Button>
          )}
        </div>
        {runner.status !== "online" ? (
          <p className="text-sm text-muted-foreground">
            Engine management is available when the runner is online.
          </p>
        ) : !runner.engineManagement ? (
          <p className="text-sm text-muted-foreground">
            This runner doesn’t support engine management.
          </p>
        ) : (
          <div id="runner-engine-management" hidden={!enginesOpen}>
            {enginesOpen && (
              <RunnerEngines scope={{ kind: "runner", runnerId: runner.id }} />
            )}
          </div>
        )}
      </section>

      <div className="py-2">
        <AlertDialog
          open={confirmOpen}
          onOpenChange={(open) => {
            if (revoke.isPending) return;
            if (open) revoke.reset();
            setConfirmOpen(open);
          }}
        >
          <AlertDialogContent>
            <AlertDialogTitle className="break-words text-lg font-semibold">
              Revoke access for {runner.name}?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm text-muted-foreground">
              This disconnects the runner from this Dispatch instance and blocks
              new sessions on it. To reconnect it, pair it again.
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
                    // The mutation state displays the error in the dialog.
                  })
                }
              >
                {revoke.isPending ? "Revoking…" : "Revoke access"}
              </Button>
            </div>
          </AlertDialogContent>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-2 hover:text-destructive"
              aria-label={`Revoke ${runner.name}`}
              data-testid={`runner-revoke-${runner.id}`}
            >
              Revoke connection
            </Button>
          </AlertDialogTrigger>
        </AlertDialog>
      </div>
    </section>
  );
}
