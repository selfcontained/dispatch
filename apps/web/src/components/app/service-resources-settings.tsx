import { useState } from "react";
import { Activity } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
            {data && (
              <Badge
                variant={stateBadgeVariant(
                  collectionEnabled ? data.overall.state : "disabled"
                )}
              >
                {stateLabel(
                  collectionEnabled ? data.overall.state : "disabled"
                )}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Health and resource insights for Dispatch, its agents, dependencies,
            and host. Collected history resets when Dispatch restarts.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {stale && (
            <span className="text-xs text-status-waiting">Data is stale</span>
          )}
          {collectionEnabled && (
            <span
              className="text-xs text-muted-foreground"
              data-testid="resources-updated-at"
            >
              {dataUpdatedAt > 0 && (
                <>
                  <span className="hidden sm:inline">Updated </span>
                  {new Date(dataUpdatedAt).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </>
              )}
            </span>
          )}
          <label className="flex h-8 items-center gap-2 rounded-md border border-border px-2.5 text-xs">
            <span>Collect metrics</span>
            <Checkbox
              checked={collectionEnabled}
              onCheckedChange={(checked) =>
                collectionMutation.mutate(checked === true)
              }
              disabled={!data || collectionMutation.isPending}
              aria-label="Collect service resource metrics"
              data-testid="resource-collection-toggle"
            />
          </label>
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
      {data && !collectionEnabled && (
        <Card data-testid="resource-collection-disabled">
          <CardContent className="flex min-h-52 items-center justify-center p-6 text-center">
            <div className="max-w-md">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-muted/40 text-muted-foreground">
                <Activity className="h-5 w-5" />
              </div>
              <div className="mt-4 text-sm font-medium">
                Metric collection is off
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Turn on Collect metrics to sample service resources every 5
                seconds and retain up to one hour of in-memory history.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
      {data && collectionEnabled && <ServiceResourcesDashboard data={data} />}
    </div>
  );
}
