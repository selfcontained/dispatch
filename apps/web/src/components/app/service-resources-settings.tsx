import { useState } from "react";

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
import { Switch } from "@/components/ui/switch";
import {
  type ResourceWindow,
  useSetServiceResourcesCollection,
  useServiceResources,
} from "@/hooks/use-service-resources";
import { ServiceResourcesDashboard } from "./service-resources-dashboard";
import { stateBadgeVariant, stateLabel } from "./service-resources-format";

export function ServiceResourcesSettings(): JSX.Element {
  const [window, setWindow] = useState<ResourceWindow>("1h");
  const { data, error, refetch, dataUpdatedAt } = useServiceResources(window);
  const collectionMutation = useSetServiceResourcesCollection(window);
  const collectionEnabled = data?.collectionEnabled ?? false;
  const stale =
    collectionEnabled &&
    dataUpdatedAt > 0 &&
    Date.now() - dataUpdatedAt > 45_000;

  return (
    <div
      className="mx-auto w-full max-w-7xl space-y-5 px-3 pb-16 pt-4 sm:px-5 md:px-8 md:pt-6"
      data-testid="service-resources-dashboard"
    >
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">Service resources</h1>
            {data && collectionEnabled && (
              <Badge variant={stateBadgeVariant(data.overall.state)}>
                {stateLabel(data.overall.state)}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Health and resource insights for Dispatch, its agents, dependencies,
            and host. Collected history resets when Dispatch restarts.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span
            className="w-20 text-right text-xs text-muted-foreground"
            data-testid="resources-updated-at"
          >
            {stale ? (
              <span className="text-status-waiting">Data is stale</span>
            ) : (
              collectionEnabled &&
              dataUpdatedAt > 0 && (
                <>
                  <span className="hidden sm:inline">Updated </span>
                  {new Date(dataUpdatedAt).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </>
              )
            )}
          </span>
          <Select
            value={window}
            onValueChange={(value) => setWindow(value as ResourceWindow)}
            disabled={!collectionEnabled}
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
        </div>
      </header>

      <div className="flex items-center justify-between gap-4 rounded-md border border-border/70 bg-muted/20 px-4 py-3.5">
        <label
          htmlFor="resource-collection-toggle"
          className="min-w-0 cursor-pointer"
        >
          <span className="block text-sm font-medium text-foreground">
            Collect resource metrics
          </span>
          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
            Sample service health and resource usage every 5 seconds and retain
            up to one hour of history in memory.
          </span>
        </label>
        <Switch
          id="resource-collection-toggle"
          checked={collectionEnabled}
          onCheckedChange={(checked) => collectionMutation.mutate(checked)}
          disabled={!data || collectionMutation.isPending}
          aria-label="Collect resource metrics"
          data-testid="resource-collection-toggle"
        />
      </div>

      {collectionMutation.error && (
        <p role="alert" className="text-sm text-status-blocked">
          {collectionMutation.error.message}
        </p>
      )}

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
      {data && collectionEnabled && <ServiceResourcesDashboard data={data} />}
    </div>
  );
}
