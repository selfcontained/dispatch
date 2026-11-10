import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ListTree, Pause, Radio, Terminal, X } from "lucide-react";
import type { BackgroundSnapshot } from "@dispatch/shared";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";

export function BackgroundWorkButton({ agentId }: { agentId: string | null }) {
  return agentId ? (
    <AgentBackgroundWork key={agentId} agentId={agentId} />
  ) : null;
}

/** Only current host-memory reports; no history, output or persisted projection. */
function AgentBackgroundWork({ agentId }: { agentId: string }) {
  const titleId = useId();
  const descriptionId = useId();
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
  if (!items.length && !open) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {(items.length > 0 || open) && (
        <PopoverTrigger asChild>
          <Button
            data-background-work-trigger=""
            variant="ghost-primary"
            size="icon-sm"
            aria-label={`Background work ${items.length}`}
            title={`Background work (${items.length})`}
          >
            <ListTree className="size-4" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
      )}
      <PopoverContent
        align="end"
        side="top"
        sideOffset={8}
        collisionPadding={12}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onEscapeKeyDown={(event) => event.stopPropagation()}
        className="w-[min(640px,calc(100vw-1.5rem))] max-h-[var(--radix-popover-content-available-height)] p-3 font-sans text-foreground"
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 id={titleId} className="text-base font-semibold">
            Background work
          </h2>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Close background work"
            onClick={() => setOpen(false)}
          >
            <X className="size-4" />
          </Button>
        </div>
        <p id={descriptionId} className="sr-only">
          Commands and monitors reported by this agent's current session.
        </p>
        <ScrollArea
          fitContentWidth
          className="max-h-[min(60vh,calc(var(--radix-popover-content-available-height)-5rem))]"
        >
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
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere] text-[13px]">
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
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
