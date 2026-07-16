import { useState } from "react";
import { ChevronDown, ChevronRight, Server } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { SubsystemSnapshot } from "@/hooks/use-service-resources";
import {
  formatMs,
  metadataLabel,
  stateBadgeVariant,
  stateLabel,
} from "./service-resources-format";

function reasonLabel(reason: SubsystemSnapshot["statusReason"]): string | null {
  if (reason === "stuck") return "A run exceeded twice its expected cadence.";
  if (reason === "stale") return "No recent successful run was observed.";
  if (reason === "failure") return "The latest observed operation failed.";
  return null;
}

function SubsystemRow({ subsystem }: { subsystem: SubsystemSnapshot }) {
  const [expanded, setExpanded] = useState(false);
  const metadata = Object.entries(subsystem.metadata);
  const statusReason = reasonLabel(subsystem.statusReason);
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        className="grid w-full grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.03] md:grid-cols-[minmax(12rem,1.4fr)_minmax(8rem,0.6fr)_minmax(8rem,0.6fr)_auto]"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        data-testid={`subsystem-${subsystem.id}`}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-sm font-medium">
            {subsystem.label}
          </span>
        </span>
        <span className="hidden text-xs text-muted-foreground md:block">
          {subsystem.lastDurationMs === null
            ? "—"
            : formatMs(subsystem.lastDurationMs)}
        </span>
        <span className="hidden text-xs text-muted-foreground md:block">
          {subsystem.inFlight > 0
            ? `${subsystem.inFlight} in flight`
            : subsystem.runs > 0
              ? `${subsystem.runs} runs`
              : "Waiting"}
        </span>
        <Badge variant={stateBadgeVariant(subsystem.state)}>
          {stateLabel(subsystem.state)}
        </Badge>
      </button>
      {expanded && (
        <div className="bg-muted/20 px-4 pb-4 pl-10 text-xs text-muted-foreground">
          <p>{subsystem.description}</p>
          {statusReason && (
            <p className="mt-2 text-status-waiting">{statusReason}</p>
          )}
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
            {subsystem.p95DurationMs !== null && (
              <span>p95 {formatMs(subsystem.p95DurationMs)}</span>
            )}
            {subsystem.failures > 0 && (
              <span>{subsystem.failures} failures</span>
            )}
            {metadata.map(([key, value]) => (
              <span key={key}>
                {metadataLabel(key)} {value.toLocaleString()}
              </span>
            ))}
          </div>
          {subsystem.lastError && (
            <p className="mt-3 text-status-blocked">{subsystem.lastError}</p>
          )}
        </div>
      )}
    </div>
  );
}

export function ServiceResourcesSubsystems({
  subsystems,
}: {
  subsystems: SubsystemSnapshot[];
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Server className="h-4 w-4 text-muted-foreground" />
          Runtime health
        </CardTitle>
        <CardDescription className="text-xs">
          Live state for Dispatch loops, dependencies, and connection managers.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <div className="hidden grid-cols-[minmax(12rem,1.4fr)_minmax(8rem,0.6fr)_minmax(8rem,0.6fr)_auto] gap-3 border-y border-border px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground md:grid">
          <span>Subsystem</span>
          <span>Duration</span>
          <span>Activity</span>
          <span>State</span>
        </div>
        {subsystems.map((subsystem) => (
          <SubsystemRow key={subsystem.id} subsystem={subsystem} />
        ))}
      </CardContent>
    </Card>
  );
}
