import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ListTree, Pause, Radio, Terminal, X } from "lucide-react";
import type { BackgroundSnapshot } from "@dispatch/shared";
import { api } from "@/lib/api";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { IconButton } from "@/components/ui/icon-button";
import { StatusDot } from "@/components/ui/status-dot";
import { statusLabel } from "@/lib/status-label";
import { LoadError } from "@/components/ui/async-boundary";
import { LoadingSkeleton } from "@/components/ui/skeleton";

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
          <IconButton
            tooltip={`Background work (${items.length})`}
            tone="success"
            data-background-work-trigger=""
            size="icon-sm"
            label={`Background work ${items.length}`}
          >
            <ListTree aria-hidden="true" />
          </IconButton>
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
          <h2 id={titleId} className="text-heading-md">
            Background work
          </h2>
          <IconButton
            size="icon-sm"
            label="Close background work"
            onClick={() => setOpen(false)}
          >
            <X />
          </IconButton>
        </div>
        <p id={descriptionId} className="sr-only">
          Commands and monitors reported by this agent's current session.
        </p>
        <ScrollArea
          fitContentWidth
          className="max-h-[min(60vh,calc(var(--radix-popover-content-available-height)-5rem))]"
        >
          {query.isPending ? (
            <LoadingSkeleton
              label="Loading background work…"
              rows={1}
              rowClassName="h-14"
            />
          ) : query.isError && !query.data ? (
            <LoadError
              thing="background work"
              error={query.error}
              retrying={query.isFetching}
              onRetry={() => void query.refetch()}
            />
          ) : !available ? (
            <p className="py-4 text-center text-body-md text-muted-foreground">
              Background visibility unavailable.
            </p>
          ) : !items.length ? (
            <p className="py-4 text-center text-body-md text-muted-foreground">
              No reported background work.
            </p>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {items.map((item) => {
                const Icon = item.kind === "monitor" ? Radio : Terminal;
                return (
                  <li
                    key={item.id}
                    className="flex min-h-9 items-center gap-2 px-1 py-2"
                  >
                    <Icon
                      className="size-3.5 shrink-0 text-muted-foreground"
                      role="img"
                      aria-label={
                        item.kind === "monitor" ? "Monitor" : "Command"
                      }
                    />
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere] text-body-sm">
                      {item.name}
                    </span>
                    <span
                      className={
                        item.state === "paused"
                          ? "flex shrink-0 items-center gap-1.5 text-body-sm text-status-waiting [[data-theme-mode=light]_&]:text-warning-ink"
                          : "flex shrink-0 items-center gap-1.5 text-body-sm text-status-working [[data-theme-mode=light]_&]:text-success-ink"
                      }
                    >
                      {item.state === "paused" ? (
                        <Pause className="size-3" aria-hidden="true" />
                      ) : (
                        <StatusDot size="sm" tone="current" />
                      )}
                      {statusLabel(item.state)}
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
