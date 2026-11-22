import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { AsyncBoundary, quietPoll } from "@/components/ui/async-boundary";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SettingRow } from "@/components/ui/setting-row";
import { LoadingSkeleton, Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAutoSave } from "@/hooks/use-auto-save";
import { Switch } from "@/components/ui/switch";
import {
  type ResourceWindow,
  useSetServiceResourcesCollection,
  useServiceResources,
} from "@/hooks/use-service-resources";
import { ServiceResourcesDashboard } from "./service-resources-dashboard";
import { SettingsGroup, SettingsPage } from "./settings-layout";
import { stateBadgeTone, stateLabel } from "./service-resources-format";

export function ServiceResourcesSettings(): JSX.Element {
  const [window, setWindow] = useState<ResourceWindow>("1h");
  const [pendingCollectionEnabled, setPendingCollectionEnabled] = useState<
    boolean | null
  >(null);
  const query = useServiceResources(window);
  const { data, dataUpdatedAt } = query;
  const collectionMutation = useSetServiceResourcesCollection();
  const autoSave = useAutoSave<boolean, "collection">((_, enabled) =>
    collectionMutation.mutateAsync(enabled)
  );
  const collectionEnabled = data?.collectionEnabled ?? false;
  const stale =
    collectionEnabled &&
    dataUpdatedAt > 0 &&
    Date.now() - dataUpdatedAt > 45_000;
  const confirmationOpen = pendingCollectionEnabled !== null;
  const confirmingEnable = pendingCollectionEnabled === true;

  const closeConfirmation = () => setPendingCollectionEnabled(null);

  return (
    <SettingsPage
      page="resources"
      status={
        data && collectionEnabled ? (
          <Badge tone={stateBadgeTone(data.overall.state)}>
            {stateLabel(data.overall.state)}
          </Badge>
        ) : null
      }
      actions={
        <>
          <span
            className="whitespace-nowrap text-body-sm text-muted-foreground"
            data-testid="resources-updated-at"
          >
            {stale ? (
              <span className="text-warning">Data is stale</span>
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
              className="h-8 w-28 text-body-sm"
              aria-label="Resource history window"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="15m">15 minutes</SelectItem>
              <SelectItem value="1h">1 hour</SelectItem>
            </SelectContent>
          </Select>
        </>
      }
    >
      <div className="space-y-8" data-testid="service-resources-dashboard">
        <SettingsGroup
          title="Collection"
          description="Collected history resets when Dispatch restarts."
        >
          <SettingRow
            label="Collect resource metrics"
            description="Sample service health and resource usage every 5 seconds and retain up to one hour of history in memory."
            status={autoSave.status("collection")}
          >
            <Switch
              id="resource-collection-toggle"
              checked={collectionEnabled}
              onCheckedChange={setPendingCollectionEnabled}
              disabled={!data || collectionMutation.isPending}
              aria-label="Collect resource metrics"
              data-testid="resource-collection-toggle"
            />
          </SettingRow>
        </SettingsGroup>

        <AsyncBoundary
          query={quietPoll(query)}
          thing="service resources"
          loading={
            <LoadingSkeleton
              label="Loading service resources…"
              className="grid gap-3 space-y-0 sm:grid-cols-3"
            >
              {Array.from({ length: 3 }, (_, card) => (
                <Skeleton key={card} className="h-32" />
              ))}
            </LoadingSkeleton>
          }
        >
          {(data) =>
            collectionEnabled ? <ServiceResourcesDashboard data={data} /> : null
          }
        </AsyncBoundary>

        <ConfirmDialog
          open={confirmationOpen}
          onOpenChange={(open) => {
            if (!open) closeConfirmation();
          }}
          data-testid="resource-collection-confirmation"
          tone={confirmingEnable ? "primary" : "danger"}
          title={
            confirmingEnable
              ? "Start collecting resource metrics?"
              : "Stop collecting resource metrics?"
          }
          description={
            confirmingEnable
              ? "Dispatch will sample service health and resource usage every 5 seconds and retain up to one hour of history in memory."
              : "Resource history currently held in memory will be cleared, and no new service metrics will be collected until you turn this back on."
          }
          confirmLabel={
            confirmingEnable ? "Start collecting" : "Stop collecting"
          }
          errorTitle={
            confirmingEnable
              ? "Couldn’t start collecting."
              : "Couldn’t stop collecting."
          }
          confirmTestId="resource-collection-confirm"
          cancelTestId="resource-collection-cancel"
          onConfirm={async () => {
            if (pendingCollectionEnabled === null) return;
            const result = await autoSave.save(
              "collection",
              pendingCollectionEnabled
            );
            // The dialog stays, with the reason and the same button to retry.
            if (!result.ok) throw result.error;
          }}
        />
      </div>
    </SettingsPage>
  );
}
