import { ProviderQuotaSection } from "@/components/app/activity-pane";
import { ScrollArea } from "@/components/ui/scroll-area";

export function UsagePane(): JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-5xl min-w-0 space-y-6 px-3 pb-12 pt-4 sm:px-5 sm:pb-20 sm:pt-6 md:px-8">
          <ProviderQuotaSection />
        </div>
      </ScrollArea>
    </div>
  );
}
