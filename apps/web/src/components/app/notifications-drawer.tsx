import { useAtom } from "jotai";
import { dismissedAttentionAtom } from "@/lib/store";
import type { AttentionHistoryItem } from "@dispatch/shared";
import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { useState } from "react";
import { AttentionCard } from "./attention-toast";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { IconButton } from "@/components/ui/icon-button";
import { api } from "@/lib/api";
import { AsyncBoundary } from "@/components/ui/async-boundary";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingSkeleton } from "@/components/ui/skeleton";

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
  // It polls every 5s: a missed poll keeps the cards, without an alert.
  const region = { ...history, error: history.data ? null : history.error };
  const items = history.data?.filter((item) => !dismissed[item.toastId]);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <IconButton label="Notifications">
          <Bell />
        </IconButton>
      </SheetTrigger>
      <SheetContent aria-describedby={undefined}>
        <div className="border-b px-4 pb-4 pt-safe-4">
          <SheetTitle className="text-heading-md">Notifications</SheetTitle>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 pb-safe-3">
          <AsyncBoundary
            query={region}
            thing="notifications"
            loading={
              <LoadingSkeleton
                label="Loading notifications…"
                rowClassName="h-20"
              />
            }
            isEmpty={() => !items?.length}
            empty={
              <EmptyState
                icon={Bell}
                title="No notifications"
                className="h-full"
              />
            }
          >
            {() =>
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
                          ([, at]) =>
                            Date.parse(at) >= Date.now() - 7 * 86400000
                        )
                      ),
                      [item.toastId]: item.createdAt,
                    }));
                    setOpen(false);
                  }}
                />
              ))
            }
          </AsyncBoundary>
        </div>
      </SheetContent>
    </Sheet>
  );
}
