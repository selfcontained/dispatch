import { useAtom } from "jotai";
import { dismissedAttentionAtom } from "@/lib/store";
import type { AttentionHistoryItem } from "@dispatch/shared";
import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { useState } from "react";
import { AttentionCard } from "./attention-toast";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { api } from "@/lib/api";

export function NotificationsDrawer(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useAtom(dismissedAttentionAtom);
  const history = useQuery({
    queryKey: ["attention-history"],
    queryFn: () => api<AttentionHistoryItem[]>("/api/v1/notifications/recent"),
    enabled: open,
    // Also refresh persisted settlements if the tab reconnects between events.
    refetchInterval: open ? 5000 : false,
  });
  const items = history.data?.filter((item) => !dismissed[item.toastId]);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button size="icon" variant="ghost" aria-label="Notifications">
          <Bell className="size-4" />
        </Button>
      </SheetTrigger>
      <SheetContent aria-describedby={undefined}>
        <div className="border-b px-4 pb-4 pt-[max(1rem,var(--safe-area-top))]">
          <SheetTitle className="text-heading-md">Notifications</SheetTitle>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {history.isPending ? (
            <p role="status" className="p-2 text-body-md text-muted-foreground">
              Loading…
            </p>
          ) : history.isError && !history.data ? (
            <div className="space-y-2 p-2">
              <p role="alert" className="text-body-md text-muted-foreground">
                Couldn’t load notifications
              </p>
              <Button variant="default" onClick={() => void history.refetch()}>
                Retry
              </Button>
            </div>
          ) : items?.length === 0 ? (
            <p className="p-2 text-body-md text-muted-foreground">
              No notifications
            </p>
          ) : (
            items?.map((item) => (
              <AttentionCard
                key={item.toastId}
                event={item}
                createdAt={item.createdAt}
                settled={item.settled}
                link
                onOpen={() => {
                  setDismissed((previous) => ({
                    ...Object.fromEntries(
                      Object.entries(previous).filter(
                        ([, at]) => Date.parse(at) >= Date.now() - 7 * 86400000
                      )
                    ),
                    [item.toastId]: item.createdAt,
                  }));
                  setOpen(false);
                }}
              />
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
