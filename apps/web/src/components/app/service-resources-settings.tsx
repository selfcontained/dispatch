import { useState } from "react";
import { RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type ResourceWindow,
  useServiceResources,
} from "@/hooks/use-service-resources";
import { cn } from "@/lib/utils";
import { ServiceResourcesDashboard } from "./service-resources-dashboard";
import { stateBadgeVariant, stateLabel } from "./service-resources-format";

export function ServiceResourcesSettings(): JSX.Element {
  const [window, setWindow] = useState<ResourceWindow>("1h");
  const { data, error, isFetching, refetch, dataUpdatedAt } =
    useServiceResources(window);
  const stale = dataUpdatedAt > 0 && Date.now() - dataUpdatedAt > 15_000;

  return (
    <div
      className="mx-auto w-full max-w-7xl space-y-5 px-3 pb-16 pt-4 sm:px-5 md:px-8 md:pt-6"
      data-testid="service-resources-dashboard"
    >
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">Service resources</h1>
            {data && (
              <Badge variant={stateBadgeVariant(data.overall.state)}>
                {stateLabel(data.overall.state)}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Live health and resource use for Dispatch, its agents, dependencies,
            and host.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {stale && (
            <span className="text-xs text-status-waiting">Data is stale</span>
          )}
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {dataUpdatedAt > 0
              ? `Updated ${new Date(dataUpdatedAt).toLocaleTimeString()}`
              : ""}
          </span>
          <Select
            value={window}
            onValueChange={(value) => setWindow(value as ResourceWindow)}
          >
            <SelectTrigger
              className="h-8 w-28 text-xs"
              aria-label="Resource history window"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="15m">15 minutes</SelectItem>
              <SelectItem value="1h">1 hour</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            onClick={() => void refetch()}
            disabled={isFetching}
            title="Refresh resources"
            data-testid="refresh-service-resources"
          >
            <RefreshCw
              className={cn("h-4 w-4", isFetching && "animate-spin")}
            />
          </Button>
        </div>
      </header>

      {!data && !error && (
        <div className="flex min-h-72 items-center justify-center text-sm text-muted-foreground">
          Loading service resources…
        </div>
      )}
      {!data && error && (
        <Card className="border-status-blocked/30">
          <CardContent className="p-6 text-sm">
            <div className="font-medium text-status-blocked">
              Resources are unavailable
            </div>
            <p className="mt-1 text-muted-foreground">{error.message}</p>
            <Button className="mt-4" size="sm" onClick={() => void refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      )}
      {data && <ServiceResourcesDashboard data={data} />}
    </div>
  );
}
