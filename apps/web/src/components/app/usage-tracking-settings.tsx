import { useEffect, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import {
  useProviderQuotaSettings,
  useUpdateProviderQuotaSettings,
} from "@/hooks/use-activity";

export function UsageTrackingSettings(): JSX.Element {
  const { data, isLoading, isError } = useProviderQuotaSettings();
  const update = useUpdateProviderQuotaSettings();
  const [checked, setChecked] = useState(true);

  useEffect(() => {
    if (data) setChecked(data.usageTrackingEnabled);
  }, [data]);

  const toggle = (enabled: boolean) => {
    setChecked(enabled);
    update.mutate(
      { usageTrackingEnabled: enabled },
      {
        onError: () => {
          setChecked(!enabled);
        },
      }
    );
  };

  return (
    <div>
      <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
        Usage tracking
      </div>
      <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
        Keep Codex and Claude quota usage up to date in the background. Dispatch
        chooses the safest available local credential path automatically.
      </p>
      <label className="flex max-w-lg cursor-pointer items-center gap-3 rounded border border-border px-3 py-2.5 transition-colors hover:bg-muted/50">
        <Checkbox
          checked={checked}
          disabled={isLoading || update.isPending}
          onCheckedChange={(value) => toggle(value === true)}
          data-testid="usage-tracking-toggle"
        />
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">
            Enable usage tracking
          </div>
          <div className="text-xs text-muted-foreground">
            {checked
              ? "Provider quotas refresh quietly in the background."
              : "Provider quota stats are hidden and background refresh is paused."}
          </div>
        </div>
      </label>
      {(isError || update.isError) && (
        <p className="mt-2 text-xs text-status-blocked">
          Failed to update usage tracking. Please try again.
        </p>
      )}
    </div>
  );
}
