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
  const statusReason = reasonLabel(subsystem.statusReason);
  const stats = [
    ...(subsystem.p95DurationMs === null
      ? []
      : [
          {
            key: "p95-duration",
            label: "p95 duration",
            value: formatMs(subsystem.p95DurationMs),
            isFailure: false,
          },
        ]),
    ...(subsystem.failures === 0
      ? []
      : [
          {
            key: "failures",
            label: "Failures",
            value: subsystem.failures.toLocaleString(),
            isFailure: true,
          },
        ]),
    ...Object.entries(subsystem.metadata).map(([key, value]) => ({
      key,
      label: metadataLabel(key),
      value: value.toLocaleString(),
      isFailure: false,
    })),
  ];
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        className="grid w-full grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.03] md:grid-cols-[minmax(12rem,1.4fr)_minmax(7rem,0.6fr)_minmax(7rem,0.6fr)_5.5rem]"
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
              ? `${subsystem.runs} ${subsystem.runs === 1 ? "run" : "runs"}`
              : subsystem.state === "healthy"
                ? "Active"
                : "Waiting"}
        </span>
        <Badge
          className="justify-self-end"
          variant={stateBadgeVariant(subsystem.state)}
        >
          {stateLabel(subsystem.state)}
        </Badge>
      </button>
      {expanded && (
        <div className="bg-muted/20 px-4 pb-4 pl-10 text-xs text-muted-foreground">
          <p>{subsystem.description}</p>
          {statusReason && (
            <p className="mt-2 text-status-waiting">{statusReason}</p>
          )}
          {stats.length > 0 && (
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {stats.map((stat) => (
                <div
                  key={stat.key}
                  className="rounded-md border border-border/80 bg-background/40 px-3 py-2 shadow-sm"
                >
                  <span className="block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {stat.label}
                  </span>
                  <span
                    className={`mt-0.5 block text-sm font-semibold tabular-nums ${
                      stat.isFailure ? "text-status-blocked" : "text-foreground"
                    }`}
                  >
                    {stat.value}
                  </span>
                </div>
              ))}
            </div>
          )}
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
        <div className="hidden grid-cols-[minmax(12rem,1.4fr)_minmax(7rem,0.6fr)_minmax(7rem,0.6fr)_5.5rem] gap-3 border-y border-border px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground md:grid">
          <span>Subsystem</span>
          <span>Duration</span>
          <span>Activity</span>
          <span className="text-right">State</span>
        </div>
        {subsystems.map((subsystem) => (
          <SubsystemRow key={subsystem.id} subsystem={subsystem} />
        ))}
      </CardContent>
    </Card>
  );
}
