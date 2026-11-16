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

export function NotificationsDrawer({
  onNavigate,
}: {
  onNavigate?: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const history = useQuery({
    queryKey: ["attention-history"],
    queryFn: () => api<AttentionHistoryItem[]>("/api/v1/notifications/recent"),
    enabled: open,
    // Also refresh persisted settlements if the tab reconnects between events.
    refetchInterval: open ? 5000 : false,
  });
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button size="icon" variant="ghost" aria-label="Notifications">
          <Bell className="size-4" />
        </Button>
      </SheetTrigger>
      <SheetContent aria-describedby={undefined}>
        <div className="border-b px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))]">
          <SheetTitle className="text-base font-semibold">
            Notifications
          </SheetTitle>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {history.isPending ? (
            <p role="status" className="p-2 text-sm text-muted-foreground">
              Loading…
            </p>
          ) : history.isError ? (
            <Button variant="default" onClick={() => void history.refetch()}>
              Retry
            </Button>
          ) : history.data.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">
              No notifications
            </p>
          ) : (
            history.data.map((item) => (
              <AttentionCard
                key={item.toastId}
                event={item}
                createdAt={item.createdAt}
                settled={item.settled}
                link
                onOpen={() => {
                  setOpen(false);
                  onNavigate?.();
                }}
              />
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
