import { useEffect, useRef } from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OperationLog, PhaseProgress } from "@/components/app/release-shared";
import type {
  AssistedCheckResult,
  AssistedUpdateState,
  ReleaseJob,
  ReleasePhase,
  UpdateMigrationManifest,
} from "@/hooks/use-release-stream";

const ASSISTED_PHASES: ReleasePhase[] = [
  "inspect",
  "prepare",
  "apply",
  "restarting",
  "validate",
  "done",
];

type AssistedUpdateProgressProps = {
  job: Extract<ReleaseJob, { jobType: "update-assisted" }>;
  onDismiss: () => void;
};

/**
 * Takeover layout for an in-flight assisted update. Mirrors the standard
 * OperationTakeover for visual consistency, but adds:
 *   - the assisted phase set
 *   - per-phase note text from the launched agent
 *   - structured check results (post-validate)
 *   - links to the launched update agent
 */
export function AssistedUpdateProgress({
  job,
  onDismiss,
}: AssistedUpdateProgressProps): JSX.Element {
  const { assisted } = job;
  const logRef = useRef<HTMLDivElement>(null);
  const isFailed =
    job.phase === "failed" ||
    job.phase === "rollback" ||
    job.phase === "blocked";
  const isDone = job.phase === "done";

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [job.log]);

  const headline =
    assisted.migrations && assisted.migrations.length > 0
      ? {
          title: `${assisted.migrations.length} migration${
            assisted.migrations.length === 1 ? "" : "s"
          } pending`,
          summary: assisted.migrations.map((m) => m.title).join(" → "),
        }
      : assisted.metadata
        ? {
            title: assisted.metadata.title,
            summary: assisted.metadata.summary ?? "",
          }
        : { title: "Assisted update", summary: "" };

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <div className="flex md:w-[380px] shrink-0 flex-col gap-6 overflow-y-auto border-b md:border-b-0 md:border-r border-white/[0.12] p-4 md:p-6">
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-widest text-muted-foreground">
            Assisted update
          </div>
          <div className="text-sm font-semibold text-foreground">
            {headline.title}
          </div>
          {headline.summary && (
            <div className="mt-1 text-xs text-muted-foreground">
              {headline.summary}
            </div>
          )}
        </div>

        <PhaseProgress
          job={job}
          phasesOrder={ASSISTED_PHASES}
          isFailed={isFailed}
          isRestarting={job.phase === "restarting"}
        />

        {assisted.migrations && assisted.migrations.length > 0 && (
          <MigrationsList migrations={assisted.migrations} />
        )}

        {Object.keys(assisted.notes).length > 0 && (
          <PhaseNotesList notes={assisted.notes} />
        )}

        {assisted.checks.length > 0 && <ChecksList checks={assisted.checks} />}

        {assisted.agentId && (
          <a
            href={`/agents/${assisted.agentId}`}
            className="inline-flex items-center gap-1.5 self-start rounded border border-white/[0.12] px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:border-white/[0.25]"
          >
            View update agent
            <span className="font-mono text-[10px] opacity-70">
              {assisted.agentId.slice(0, 12)}
            </span>
          </a>
        )}

        {isDone && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 rounded border border-green-500/30 bg-green-500/10 px-3 py-2.5 text-sm text-green-400">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>
                Updated to{" "}
                <span className="font-mono font-semibold">{job.tag}</span>
              </span>
            </div>
            <Button
              variant="default"
              onClick={onDismiss}
              className="self-start"
            >
              Done
            </Button>
          </div>
        )}

        {isFailed && (
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-2 rounded border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="flex flex-col">
                <span>
                  {job.phase === "rollback"
                    ? "Update rolled back"
                    : job.phase === "blocked"
                      ? "Update blocked — required checks did not pass"
                      : "Update failed"}
                </span>
                {(assisted?.error ?? job.error) && (
                  <span className="mt-1 text-xs">
                    {assisted?.error ?? job.error}
                  </span>
                )}
              </div>
            </div>
            <Button
              variant="default"
              onClick={onDismiss}
              className="self-start"
            >
              Dismiss
            </Button>
          </div>
        )}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col p-2">
        <OperationLog
          logRef={logRef}
          job={job}
          isRestarting={job.phase === "restarting"}
          postRestartPolling={false}
        />
      </div>
    </div>
  );
}

function PhaseNotesList({
  notes,
}: {
  notes: AssistedUpdateState["notes"];
}): JSX.Element {
  const entries = Object.entries(notes) as Array<[ReleasePhase, string]>;
  return (
    <div>
      <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
        Agent notes
      </div>
      <ul className="flex flex-col gap-1.5 text-xs">
        {entries.map(([phase, note]) => (
          <li
            key={phase}
            className="rounded border border-white/[0.08] bg-white/[0.03] px-2 py-1.5"
          >
            <div className="font-mono uppercase tracking-wide text-[9px] text-muted-foreground">
              {phase}
            </div>
            <div className="text-foreground/90">{note}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MigrationsList({
  migrations,
}: {
  migrations: UpdateMigrationManifest[];
}): JSX.Element {
  return (
    <div>
      <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
        Migrations
      </div>
      <ol className="flex flex-col gap-1.5 text-xs">
        {migrations.map((m, idx) => (
          <li
            key={m.id}
            className="rounded border border-white/[0.08] bg-white/[0.03] px-2 py-1.5"
          >
            <div className="flex items-center gap-2">
              <span className="font-mono uppercase tracking-wide text-[9px] text-muted-foreground">
                {idx + 1}/{migrations.length}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {m.id}
              </span>
            </div>
            <div className="mt-0.5 text-foreground/90">{m.title}</div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ChecksList({
  checks,
}: {
  checks: AssistedCheckResult[];
}): JSX.Element {
  return (
    <div>
      <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
        Required checks
      </div>
      <ul className="flex flex-col gap-1 text-xs">
        {checks.map((c) => (
          <li key={c.name} className="flex items-start gap-2">
            {c.ok ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-500" />
            ) : (
              <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            )}
            <div className="flex flex-col">
              <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                {c.name}
              </span>
              <span
                className={c.ok ? "text-foreground/90" : "text-destructive"}
              >
                {c.message}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
