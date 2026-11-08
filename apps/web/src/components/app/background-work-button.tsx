import "./background-work.css";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Pause, Radio, Terminal, X } from "lucide-react";
import type { BackgroundSnapshot } from "@dispatch/shared";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/** Only current host-memory reports; no history, output or persisted projection. */
export function BackgroundWorkButton({ agentId }: { agentId: string | null }) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["background-work", agentId],
    queryFn: () =>
      api<BackgroundSnapshot>(
        `/api/v1/agents/${encodeURIComponent(agentId!)}/background-work`
      ),
    enabled: !!agentId,
    refetchInterval: open ? 2000 : 10000,
  });
  if (!agentId) return null;
  const available = !query.isError && query.data?.status === "supported";
  const items = available ? query.data!.items : [];
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5"
          aria-label={`Background work${items.length ? ` ${items.length}` : ""}`}
        >
          <Activity className="size-3.5" />
          <span className="hidden sm:inline">Background work</span>
          <span className="sm:hidden">Work</span>
          {items.length > 0 && (
            <span className="rounded bg-muted px-1 text-[11px] tabular-nums">
              {items.length}
            </span>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent
        overlayClassName="background-work-overlay"
        className="background-work-dialog w-[min(440px,calc(100vw-2rem))] gap-2 p-3 font-sans text-foreground"
      >
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle className="text-base">Background work</DialogTitle>
            <DialogClose asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Close background work"
              >
                <X className="size-4" />
              </Button>
            </DialogClose>
          </div>
          <DialogDescription className="sr-only">
            Commands and monitors reported by this agent's current session.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto">
          {query.isPending ? (
            <div
              className="h-14 animate-pulse rounded-lg bg-muted/50"
              aria-label="Loading background work"
            />
          ) : !available ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Background visibility unavailable.
            </p>
          ) : !items.length ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No reported background work.
            </p>
          ) : (
            <ul className="divide-y divide-border/40">
              {items.map((item) => {
                const Icon = item.kind === "monitor" ? Radio : Terminal;
                return (
                  <li
                    key={item.id}
                    className="flex min-h-9 items-center gap-2.5 px-1 py-2"
                  >
                    <Icon
                      className="size-3.5 shrink-0 text-muted-foreground"
                      role="img"
                      aria-label={
                        item.kind === "monitor" ? "Monitor" : "Command"
                      }
                    />
                    <span className="min-w-0 flex-1 break-words text-[13px] line-clamp-2">
                      {item.name}
                    </span>
                    <span
                      className={
                        item.state === "paused"
                          ? "flex shrink-0 items-center gap-1.5 text-xs text-status-waiting [[data-theme-mode=light]_&]:text-amber-800"
                          : "flex shrink-0 items-center gap-1.5 text-xs text-status-working [[data-theme-mode=light]_&]:text-emerald-800"
                      }
                    >
                      {item.state === "paused" ? (
                        <Pause className="size-3" aria-hidden="true" />
                      ) : (
                        <span
                          className="size-1.5 rounded-full bg-current"
                          aria-hidden="true"
                        />
                      )}
                      {item.state}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
