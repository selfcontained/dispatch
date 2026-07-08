import { useState } from "react";
import { ProviderQuotaSection } from "@/components/app/activity-pane";
import {
  ACTIVITY_RANGES,
  rangeLabel,
  type ActivityRange,
} from "@/hooks/use-activity";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function UsagePane(): JSX.Element {
  const [range, setRange] = useState<ActivityRange>("30d");

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-5">
        <div className="ml-auto">
          <Select
            value={range}
            onValueChange={(value) => setRange(value as ActivityRange)}
          >
            <SelectTrigger
              className="h-8 w-[132px] bg-muted/30 text-xs"
              data-testid="usage-range-select"
              aria-label="Usage time range"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACTIVITY_RANGES.map((option) => (
                <SelectItem key={option} value={option}>
                  {rangeLabel(option)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-5xl min-w-0 space-y-6 px-3 pb-12 pt-4 sm:px-5 sm:pb-20 sm:pt-6 md:px-8">
          <ProviderQuotaSection range={range} />
        </div>
      </ScrollArea>
    </div>
  );
}
