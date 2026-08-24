import { useAtom, useAtomValue } from "jotai";
import { RefreshCw, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  usePluginStatus,
  useUpdatePlugin,
  type PluginCliAgentType,
  type PluginStatus,
} from "@/hooks/use-plugin-status";
import { dismissedPluginUpdateAtomFamily } from "@/lib/store";

const AGENT_TYPE_LABELS: Record<PluginCliAgentType, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

function dismissalKey(status: PluginStatus): string {
  return `${status.agentType}:${status.latestVersion ?? ""}`;
}

function PluginUpdateRow({ status }: { status: PluginStatus }): JSX.Element {
  const [, setDismissed] = useAtom(
    dismissedPluginUpdateAtomFamily(dismissalKey(status))
  );
  const { mutate, isPending, error } = useUpdatePlugin();

  return (
    <div className="flex items-start justify-between gap-3 rounded border border-border px-3 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          {AGENT_TYPE_LABELS[status.agentType]}
          <Badge variant="running">Update available</Badge>
        </div>
        <div className="text-xs text-muted-foreground">
          v{status.currentVersion} → v{status.latestVersion}
        </div>
        {error ? (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {error.message}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          variant="primary"
          size="sm"
          disabled={isPending}
          onClick={() => mutate(status.agentType)}
        >
          <RefreshCw
            className={`mr-1.5 h-3.5 w-3.5 ${isPending ? "animate-spin" : ""}`}
          />
          {isPending ? "Updating…" : "Update"}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          disabled={isPending}
          aria-label={`Dismiss ${AGENT_TYPE_LABELS[status.agentType]} update`}
          onClick={() => setDismissed(true)}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Nudges toward updating the Dispatch plugin per installed CLI (Claude Code,
 * Codex) once a newer version is published. Renders nothing when nothing is
 * installed, everything is current, or every actionable row has been
 * dismissed — this isn't the install affordance (see the
 * plugin-install-detection-nudge idea), so a CLI with no plugin installed at
 * all is silently out of scope here.
 *
 * Dismissal is keyed by version (see dismissedPluginUpdateAtomFamily): unlike
 * a first-install dismissal, "not now" here must not silence every future
 * release too. The section header must not outlive its last visible row, so
 * dismissal is read here as well — two explicit hook calls (Claude, Codex)
 * rather than one inside each row, since the pair is fixed and small enough
 * that looping over it would only trade clarity for no real flexibility.
 */
export function PluginUpdateSettings(): JSX.Element | null {
  const { data } = usePluginStatus();
  const statuses = data?.statuses ?? [];
  const claude = statuses.find((s) => s.agentType === "claude") ?? null;
  const codex = statuses.find((s) => s.agentType === "codex") ?? null;

  const claudeDismissed = useAtomValue(
    dismissedPluginUpdateAtomFamily(claude ? dismissalKey(claude) : "claude:")
  );
  const codexDismissed = useAtomValue(
    dismissedPluginUpdateAtomFamily(codex ? dismissalKey(codex) : "codex:")
  );

  const visible = [
    claude && claude.updateAvailable && !claudeDismissed ? claude : null,
    codex && codex.updateAvailable && !codexDismissed ? codex : null,
  ].filter((s): s is PluginStatus => s !== null);

  if (visible.length === 0) return null;

  return (
    <div className="flex flex-col gap-4 border-t border-border p-6">
      <div>
        <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          Plugin update
        </div>
        <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
          A newer version of the Dispatch plugin is available for one or more
          CLIs.
        </p>
      </div>
      <div className="max-w-lg space-y-2">
        {visible.map((status) => (
          <PluginUpdateRow key={status.agentType} status={status} />
        ))}
      </div>
    </div>
  );
}
