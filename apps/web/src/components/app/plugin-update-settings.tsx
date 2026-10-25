import { useState } from "react";
import { Download, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyIconButton } from "@/components/ui/copy-button";
import { useCopyText } from "@/hooks/use-copy";
import {
  AGENT_TYPE_LABELS,
  usePluginStatus,
  useRefreshPluginStatus,
  useUpdatePlugin,
  type PluginStatus,
} from "@/hooks/use-plugin-status";

const MANUAL_COMMANDS = {
  claude: {
    install: [
      "claude plugin marketplace add selfcontained/dispatch",
      "claude plugin install dispatch@dispatch",
    ],
    update: [
      "claude plugin marketplace update dispatch",
      "claude plugin update dispatch@dispatch",
    ],
  },
  codex: {
    install: [
      "codex plugin marketplace add selfcontained/dispatch",
      "codex plugin add dispatch@dispatch",
    ],
    update: [
      "codex plugin marketplace upgrade dispatch",
      "codex plugin add dispatch@dispatch",
    ],
  },
} as const;

function ManualCommand({ command }: { command: string }): JSX.Element {
  const [copied, copyText] = useCopyText();
  return (
    <li className="pl-1 marker:text-muted-foreground">
      <div className="flex min-w-0 items-center gap-1 rounded bg-muted/50 py-1 pl-2 pr-1">
        <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-foreground">
          {command}
        </code>
        <CopyIconButton
          copied={copied}
          onCopy={() => copyText(command)}
          label={`Copy ${command}`}
          className="shrink-0"
        />
      </div>
    </li>
  );
}

function PluginRow({ status }: { status: PluginStatus }): JSX.Element {
  const [manualOpen, setManualOpen] = useState(false);
  const action = status.installed ? "update" : "install";
  const { mutate, isPending, error } = useUpdatePlugin(action);
  const label = AGENT_TYPE_LABELS[status.agentType];
  const manualCommands = MANUAL_COMMANDS[status.agentType][action];
  const manualPanelId = `plugin-manual-${status.agentType}`;
  const canAct =
    !status.detectionError && (!status.installed || status.updateAvailable);
  const state = status.detectionError
    ? "Status unavailable"
    : !status.installed
      ? "Not installed"
      : !status.enabled
        ? "Disabled"
        : status.updateAvailable
          ? "Update available"
          : status.latestVersion === null
            ? "Latest version unavailable"
            : "Up to date";

  return (
    <div className="rounded border border-border px-3 py-3">
      <div className="flex min-h-12 items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">{label}</div>
          {status.installed ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {status.currentVersion
                ? `Installed v${status.currentVersion}`
                : "Installed version unknown"}
              {status.updateAvailable ? ` → v${status.latestVersion}` : ""}
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              Dispatch skills
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Badge
            variant={status.updateAvailable ? "running" : "default"}
            className="max-w-36 rounded-none border-0 bg-transparent p-0 text-right text-xs font-normal normal-case tracking-normal"
          >
            {state}
          </Badge>
          {canAct ? (
            <Button
              variant="default"
              size="sm"
              className="h-7 min-w-24 text-xs"
              disabled={isPending}
              aria-busy={isPending}
              aria-label={`${action === "install" ? "Install" : "Update"} ${label} plugin`}
              onClick={() => mutate(status.agentType)}
            >
              {isPending ? (
                <RefreshCw className="mr-1.5 h-3 w-3 animate-spin" />
              ) : action === "install" ? (
                <Download className="mr-1.5 h-3 w-3" />
              ) : (
                <RefreshCw className="mr-1.5 h-3 w-3" />
              )}
              {isPending
                ? action === "install"
                  ? "Installing…"
                  : "Updating…"
                : action === "install"
                  ? "Install"
                  : "Update"}
            </Button>
          ) : null}
        </div>
      </div>
      {status.detectionError ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {status.detectionError}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="mt-2 whitespace-pre-line text-xs text-destructive"
        >
          {error.message}{" "}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto p-0 text-xs text-destructive underline"
            onClick={() => setManualOpen(true)}
            aria-controls={manualPanelId}
          >
            Run it manually
          </Button>
        </p>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mt-2 h-7 px-2 text-xs text-muted-foreground"
        aria-expanded={manualOpen}
        aria-controls={manualPanelId}
        onClick={() => setManualOpen((open) => !open)}
      >
        Manual commands
      </Button>
      {manualOpen ? (
        <div id={manualPanelId} className="mt-1 min-w-0 space-y-2">
          <ol
            className="list-decimal space-y-1.5 pl-4 text-xs"
            aria-label={`${label} manual commands`}
          >
            {manualCommands.map((command) => (
              <ManualCommand key={command} command={command} />
            ))}
          </ol>
          <p className="text-xs text-muted-foreground">
            Then start a fresh agent session.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** Persistent plugin inventory for the enabled Claude Code and Codex CLIs. */
export function PluginUpdateSettings(): JSX.Element {
  const { data, isPending, isFetching, error } = usePluginStatus();
  const refresh = useRefreshPluginStatus();
  const checking = isFetching || refresh.isPending;
  return (
    <section
      aria-label="Dispatch plugins"
      className="flex flex-col gap-4 border-t border-border p-6"
    >
      <div className="max-w-lg">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">
            Dispatch plugins
          </h2>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={checking}
            onClick={() => refresh.mutate()}
          >
            <RefreshCw
              className={`mr-1.5 h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`}
            />
            Check again
          </Button>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Skills for your enabled Claude Code and Codex CLIs. Install or update
          on this Dispatch server, then start a fresh agent session to load
          them.
        </p>
      </div>
      <div className="max-w-lg space-y-2">
        {isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Checking plugin versions…
          </p>
        ) : null}
        {error || refresh.error ? (
          <p role="alert" className="text-sm text-destructive">
            Could not load plugin status. Check again to retry.
          </p>
        ) : null}
        {data?.statuses.map((status) => (
          <PluginRow key={status.agentType} status={status} />
        ))}
        {data?.statuses.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Enable Claude Code or Codex in Settings → Agents to manage its
            Dispatch plugin.
          </p>
        ) : null}
      </div>
    </section>
  );
}
