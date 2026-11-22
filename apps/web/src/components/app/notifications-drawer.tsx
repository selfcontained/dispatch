import { useAtom } from "jotai";
import { dismissedAttentionAtom } from "@/lib/store";
import type { AttentionHistoryItem } from "@dispatch/shared";
import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { useState } from "react";
import { AttentionCard } from "./attention-toast";
import { Sheet, SheetHeader } from "@/components/ui/sheet";
import { IconButton } from "@/components/ui/icon-button";
import { api } from "@/lib/api";
import { AsyncBoundary, quietPoll } from "@/components/ui/async-boundary";
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
  const region = quietPoll(history);
  const items = history.data?.filter((item) => !dismissed[item.toastId]);
  return (
    <>
      <IconButton
        label="Notifications"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Bell />
      </IconButton>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        keepMounted={false}
        size="md"
        label="Notifications"
      >
        <SheetHeader title="Notifications" onClose={() => setOpen(false)} />
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
      </Sheet>
    </>
  );
}
