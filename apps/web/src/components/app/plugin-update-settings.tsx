import { useAtom } from "jotai";
import { useState } from "react";
import { RefreshCw, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AGENT_TYPE_LABELS,
  usePluginStatus,
  useUpdatePlugin,
  type PluginStatus,
} from "@/hooks/use-plugin-status";
import { dismissedPluginUpdateAtomFamily } from "@/lib/store";

function dismissalKey(status: PluginStatus): string {
  return `${status.agentType}:${status.latestVersion ?? ""}`;
}

/** Presentational — the parent owns dismissal state (read and write) so the section header can react to it too; see PluginUpdateSettings. */
function PluginUpdateRow({
  status,
  onDismiss,
}: {
  status: PluginStatus;
  onDismiss: () => void;
}): JSX.Element {
  const { mutate, isPending, error } = useUpdatePlugin();
  const label = AGENT_TYPE_LABELS[status.agentType];

  return (
    <div className="flex items-start justify-between gap-3 rounded border border-border px-3 py-2.5">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium text-foreground">
          <span className="truncate">{label}</span>
          <Badge variant="running" className="shrink-0 whitespace-nowrap">
            Update available
          </Badge>
        </div>
        <div className="text-xs text-muted-foreground">
          v{status.currentVersion} → v{status.latestVersion}
        </div>
        {error ? (
          <p
            role="alert"
            title={error.message}
            className="mt-1 line-clamp-3 whitespace-pre-line text-xs text-destructive"
          >
            {error.message}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          variant="primary"
          size="sm"
          aria-disabled={isPending}
          aria-busy={isPending}
          onClick={() => {
            if (isPending) return;
            mutate(status.agentType);
          }}
        >
          <RefreshCw
            className={`mr-1.5 h-3.5 w-3.5 ${isPending ? "animate-spin" : ""}`}
          />
          {isPending ? "Updating…" : "Update"}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-disabled={isPending}
          aria-label={`Dismiss ${label} update`}
          onClick={() => {
            if (isPending) return;
            onDismiss();
          }}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Nudges toward updating the Dispatch plugin per installed CLI (Claude Code,
 * Codex) once a newer version is published. Renders no visible section when
 * nothing is installed, everything is current, or every actionable row has
 * been dismissed — this isn't the install affordance (see the
 * plugin-install-detection-nudge idea), so a CLI with no plugin installed at
 * all is silently out of scope here.
 *
 * Dismissal is keyed by version (see dismissedPluginUpdateAtomFamily): unlike
 * a first-install dismissal, "not now" here must not silence every future
 * release too. It's read (and written) here, in the parent, rather than
 * inside each row — the section header must not outlive its last visible
 * row, so the parent needs to know dismissal state regardless, and a row
 * subscribing to the same atom again would just be a second owner of one
 * piece of state. Two explicit hook calls (Claude, Codex) rather than a loop
 * over `statuses`, since the pair is fixed and small enough that looping
 * would only trade clarity for no real flexibility.
 *
 * A dismissed/updated row unmounting drops focus to the document body with
 * no visual trace — expected when content the user just acted on goes away,
 * but screen-reader users get no confirmation anything happened without an
 * explicit announcement. Rather than chase focus to some stable neighbour
 * (coupling this component to settings-pane's structure), the wrapper below
 * always stays mounted and carries a polite live region for that
 * announcement, even when the visible section itself is absent.
 */
export function PluginUpdateSettings(): JSX.Element {
  const { data } = usePluginStatus();
  const statuses = data?.statuses ?? [];
  const claude = statuses.find((s) => s.agentType === "claude") ?? null;
  const codex = statuses.find((s) => s.agentType === "codex") ?? null;

  const [claudeDismissed, setClaudeDismissed] = useAtom(
    dismissedPluginUpdateAtomFamily(claude ? dismissalKey(claude) : "claude:")
  );
  const [codexDismissed, setCodexDismissed] = useAtom(
    dismissedPluginUpdateAtomFamily(codex ? dismissalKey(codex) : "codex:")
  );
  const [announcement, setAnnouncement] = useState("");

  const rows: Array<{ status: PluginStatus; onDismiss: () => void }> = [
    claude && claude.updateAvailable && !claudeDismissed
      ? {
          status: claude,
          onDismiss: () => {
            setClaudeDismissed(true);
            setAnnouncement(`${AGENT_TYPE_LABELS.claude} update dismissed.`);
          },
        }
      : null,
    codex && codex.updateAvailable && !codexDismissed
      ? {
          status: codex,
          onDismiss: () => {
            setCodexDismissed(true);
            setAnnouncement(`${AGENT_TYPE_LABELS.codex} update dismissed.`);
          },
        }
      : null,
  ].filter(
    (r): r is { status: PluginStatus; onDismiss: () => void } => r !== null
  );

  return (
    <>
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {rows.length > 0 ? (
        <div className="flex flex-col gap-4 border-t border-border p-6">
          <div>
            <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
              Plugin update
            </div>
            <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
              A newer version of the Dispatch plugin is available for one or
              more CLIs.
            </p>
          </div>
          <div className="max-w-lg space-y-2">
            {rows.map(({ status, onDismiss }) => (
              <PluginUpdateRow
                key={status.agentType}
                status={status}
                onDismiss={onDismiss}
              />
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
