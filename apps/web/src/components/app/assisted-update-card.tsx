import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { OperationLog, PhaseProgress } from "@/components/app/release-shared";
import type {
  AssistedCheckResult,
  AssistedUpdateMetadata,
  AssistedUpdateState,
  ReleaseJob,
  ReleasePhase,
} from "@/hooks/use-release-stream";
import { cn } from "@/lib/utils";

const ASSISTED_PHASES: ReleasePhase[] = [
  "inspect",
  "prepare",
  "apply",
  "restarting",
  "validate",
  "done",
];

function checkName(
  c: AssistedUpdateMetadata["requiredChecks"][number]
): string {
  return typeof c === "string" ? c : c.name;
}

type AssistedUpdateGateProps = {
  tag: string;
  metadata: AssistedUpdateMetadata;
  /** True when the release is mode=required for the current install. */
  required: boolean;
  onStart: () => Promise<void>;
  starting: boolean;
  startError: string | null;
};

/**
 * The pre-launch card shown in place of the one-click update button when a
 * release declares assisted-update metadata. For required releases the
 * generic update path is unavailable — the operator must acknowledge the
 * displayed guidance before launching the assisted agent.
 */
export function AssistedUpdateGate({
  tag,
  metadata,
  required,
  onStart,
  starting,
  startError,
}: AssistedUpdateGateProps): JSX.Element {
  const [acknowledged, setAcknowledged] = useState(false);
  const [instructionsOpen, setInstructionsOpen] = useState(true);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const checks = metadata.requiredChecks.map(checkName);

  return (
    <div
      className={cn(
        "flex flex-col gap-4 rounded-lg border p-4",
        required
          ? "border-amber-500/40 bg-amber-500/[0.06]"
          : "border-blue-500/30 bg-blue-500/[0.06]"
      )}
    >
      <div className="flex items-start gap-2">
        {required ? (
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        ) : (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" />
        )}
        <div className="flex flex-col gap-1">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
            {required
              ? "Assisted update required"
              : "Assisted update recommended"}
          </div>
          <div className="text-sm font-semibold text-foreground">
            {metadata.title}
          </div>
          <div className="font-mono text-xs text-muted-foreground">{tag}</div>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">{metadata.summary}</p>

      {metadata.instructions && (
        <div>
          <button
            onClick={() => setInstructionsOpen((v) => !v)}
            className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
          >
            {instructionsOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Instructions
          </button>
          {instructionsOpen && (
            <div className="mt-2 max-h-56 overflow-y-auto rounded border border-white/[0.12] bg-white/[0.04] p-3 text-sm text-muted-foreground">
              <Markdown>{metadata.instructions}</Markdown>
            </div>
          )}
        </div>
      )}

      {checks.length > 0 && (
        <div>
          <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
            Required checks
          </div>
          <ul className="flex flex-col gap-0.5 text-sm">
            {checks.map((c) => (
              <li
                key={c}
                className="flex items-center gap-2 font-mono text-xs text-muted-foreground"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
                {c}
              </li>
            ))}
          </ul>
        </div>
      )}

      {metadata.rollbackGuidance && (
        <div>
          <button
            onClick={() => setRollbackOpen((v) => !v)}
            className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
          >
            {rollbackOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Rollback guidance
          </button>
          {rollbackOpen && (
            <div className="mt-2 max-h-56 overflow-y-auto rounded border border-white/[0.12] bg-white/[0.04] p-3 text-sm text-muted-foreground">
              <Markdown>{metadata.rollbackGuidance}</Markdown>
            </div>
          )}
        </div>
      )}

      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          className="h-4 w-4 cursor-pointer"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          disabled={starting}
        />
        I have read the instructions and understand the migration steps
      </label>

      {startError && (
        <div className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {startError}
        </div>
      )}

      <Button
        size="sm"
        variant="primary"
        disabled={!acknowledged || starting}
        onClick={() => void onStart()}
        className="self-start"
      >
        {starting ? "Launching agent..." : `Start assisted update to ${tag}`}
      </Button>
    </div>
  );
}

type AssistedUpdateProgressProps = {
  job: ReleaseJob;
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
  const assisted = job.assisted ?? null;
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

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <div className="flex md:w-[380px] shrink-0 flex-col gap-6 overflow-y-auto border-b md:border-b-0 md:border-r border-white/[0.12] p-4 md:p-6">
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-widest text-muted-foreground">
            Assisted update
          </div>
          <div className="text-sm font-semibold text-foreground">
            {assisted?.metadata.title ?? `Updating to ${job.tag ?? "?"}`}
          </div>
          {assisted?.metadata.summary && (
            <div className="mt-1 text-xs text-muted-foreground">
              {assisted.metadata.summary}
            </div>
          )}
        </div>

        <PhaseProgress
          job={job}
          phasesOrder={ASSISTED_PHASES}
          isFailed={isFailed}
          isRestarting={job.phase === "restarting"}
        />

        {assisted && Object.keys(assisted.notes).length > 0 && (
          <PhaseNotesList notes={assisted.notes} />
        )}

        {assisted && assisted.checks.length > 0 && (
          <ChecksList checks={assisted.checks} />
        )}

        {assisted?.agentId && (
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
