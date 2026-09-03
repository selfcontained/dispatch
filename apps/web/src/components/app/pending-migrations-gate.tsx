import { ShieldAlert } from "lucide-react";
import type { PendingMigration } from "@/hooks/use-release-stream";
import { cn } from "@/lib/utils";

type PendingMigrationsGateProps = {
  tag: string;
  pendingMigrations: PendingMigration[];
};

/**
 * Pre-launch card shown when the target release has unapplied install-update
 * migration manifests (CRU-146). Informational only — the action lives in the
 * unified split button rendered by UpdatesSection below.
 */
export function PendingMigrationsGate({
  tag,
  pendingMigrations,
}: PendingMigrationsGateProps): JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-col gap-4 rounded-lg border p-4",
        "border-amber-500/40 bg-amber-500/[0.06]"
      )}
      data-testid="pending-migrations-gate"
    >
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        <div className="flex flex-col gap-1">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Agent-assisted update required
          </div>
          <div className="text-sm font-semibold text-foreground">
            {pendingMigrations.length} complex update step
            {pendingMigrations.length === 1 ? "" : "s"}
          </div>
          <div className="font-mono text-xs text-muted-foreground">{tag}</div>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        This release has update steps that haven&rsquo;t run on this install
        yet. The agent walks them in order and validates each.
      </p>

      <ul className="flex flex-col gap-2 text-sm">
        {pendingMigrations.map((m) => (
          <li
            key={m.id}
            className="rounded border border-white/[0.12] bg-white/[0.04] p-3"
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                {m.id}
              </span>
              <span className="font-semibold text-foreground">{m.title}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{m.summary}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
