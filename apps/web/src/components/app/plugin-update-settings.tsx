import { useState } from "react";
import { ChevronDown, Download, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { CopyIconButton } from "@/components/ui/copy-button";
import { useCopyText } from "@/hooks/use-copy";
import {
  AGENT_TYPE_LABELS,
  usePluginStatus,
  useRefreshPluginStatus,
  useUpdatePlugin,
  type PluginStatus,
} from "@/hooks/use-plugin-status";
import { SettingsGroup } from "@/components/app/settings-layout";
import { Panel } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { LoadError } from "@/components/ui/async-boundary";
import { LoadingSkeleton } from "@/components/ui/skeleton";

const MANUAL_COMMANDS = {
  claude: {
    install: [
      "claude plugin marketplace add selfcontained/dispatch",
      "claude plugin marketplace update dispatch",
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
      "codex plugin marketplace upgrade dispatch",
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
      <div className="flex min-w-0 items-center gap-1 rounded-sm bg-surface-hover py-1 pl-2 pr-1">
        <code className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-label-sm text-foreground">
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
    <Panel>
      <div className="flex min-h-12 items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-body-md font-medium text-foreground">
            {label}
          </div>
          {status.installed ? (
            <p className="mt-1 text-body-sm text-muted-foreground">
              {status.currentVersion
                ? `Installed v${status.currentVersion}`
                : "Installed version unknown"}
              {status.updateAvailable ? ` → v${status.latestVersion}` : ""}
            </p>
          ) : (
            <p className="mt-1 text-body-sm text-muted-foreground">
              Dispatch skills
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Badge tone={status.updateAvailable ? "success" : "neutral"}>
            {state}
          </Badge>
          {canAct ? (
            <Button
              size="xs"
              className="min-w-24"
              pending={isPending}
              aria-label={`${action === "install" ? "Install" : "Update"} ${label} plugin`}
              onClick={() => mutate(status.agentType)}
            >
              {action === "install" ? <Download /> : <RefreshCw />}
              {action === "install" ? "Install" : "Update"}
            </Button>
          ) : null}
        </div>
      </div>
      {status.detectionError ? (
        <p className="mt-2 text-body-sm text-muted-foreground">
          {status.detectionError}
        </p>
      ) : null}
      {error ? (
        <Alert
          title={`Couldn’t ${action} the ${label} plugin.`}
          error={error}
          className="mt-2"
          action={{
            label: "Retry",
            onClick: () => mutate(status.agentType),
            pending: isPending,
          }}
          secondaryAction={{
            label: "Run it manually",
            onClick: () => setManualOpen(true),
          }}
        />
      ) : null}
      <Collapsible open={manualOpen} onOpenChange={setManualOpen}>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            size="xs"
            className="group mt-2 text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className="transition-transform group-data-[state=open]:rotate-180" />
            Manual commands
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-1 min-w-0 space-y-2">
          <ol
            className="list-decimal space-y-1.5 pl-4 text-body-sm"
            aria-label={`${label} manual commands`}
          >
            {manualCommands.map((command) => (
              <ManualCommand key={command} command={command} />
            ))}
          </ol>
          {action === "install" ? (
            <p className="text-body-sm text-muted-foreground">
              Skip step 1 if the dispatch marketplace is already added.
            </p>
          ) : null}
          <p className="text-body-sm text-muted-foreground">
            Then start a fresh agent session.
          </p>
        </CollapsibleContent>
      </Collapsible>
    </Panel>
  );
}

/** Persistent plugin inventory for the enabled Claude Code and Codex CLIs. */
export function PluginUpdateSettings(): JSX.Element {
  const { data, isPending, isFetching, error } = usePluginStatus();
  const refresh = useRefreshPluginStatus();
  const checking = isFetching || refresh.isPending;
  return (
    <SettingsGroup
      aria-label="Dispatch plugins"
      title="Dispatch plugins"
      description="Skills for your enabled Claude Code and Codex CLIs. Install or update on this Dispatch server, then start a fresh agent session to load them."
      actions={
        <Button
          variant="ghost"
          size="xs"
          disabled={checking}
          onClick={() => refresh.mutate()}
        >
          <RefreshCw className={checking ? "animate-spin" : undefined} />
          Check again
        </Button>
      }
    >
      {isPending ? (
        <LoadingSkeleton
          label="Checking plugin versions…"
          rows={2}
          rowClassName="h-20"
        />
      ) : null}
      {error || refresh.error ? (
        <LoadError
          thing="plugin status"
          error={error ?? refresh.error}
          retrying={checking}
          onRetry={() => refresh.mutate()}
        />
      ) : null}
      {data?.statuses.map((status) => (
        <PluginRow key={status.agentType} status={status} />
      ))}
      {data?.statuses.length === 0 ? (
        <p className="text-body-md text-muted-foreground">
          Enable Claude Code or Codex in Settings → Agents to manage its
          Dispatch plugin.
        </p>
      ) : null}
    </SettingsGroup>
  );
}
