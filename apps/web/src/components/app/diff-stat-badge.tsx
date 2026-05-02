import { useEffect, useRef, useState } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { DiffStats } from "@/components/app/types";
import { cn } from "@/lib/utils";

const STALE_AFTER_MS = 30_000;
const FLASH_DURATION_MS = 600;

function formatCount(n: number): string {
  if (n < 1_000) return String(n);
  const thousands = n / 1_000;
  return `${thousands.toFixed(thousands < 10 ? 1 : 0)}K`;
}

export type DiffStatBadgeProps = {
  diffStats: DiffStats | null | undefined;
  /**
   * Latest agent event timestamp (ISO). Used together with `computedAt`
   * to detect when the agent has reported activity since the last
   * compute — a hint that the cached value may be stale.
   */
  latestEventAt: string | null | undefined;
  onRefresh: () => void;
};

export function DiffStatBadge({
  diffStats,
  latestEventAt,
  onRefresh,
}: DiffStatBadgeProps): JSX.Element | null {
  const [flash, setFlash] = useState(false);
  const lastSig = useRef<string | null>(null);

  const sig = diffStats
    ? `${diffStats.added}:${diffStats.deleted}:${diffStats.files}`
    : null;

  useEffect(() => {
    if (sig === null) {
      lastSig.current = null;
      return;
    }
    if (lastSig.current !== null && lastSig.current !== sig) {
      setFlash(true);
      const timer = window.setTimeout(() => setFlash(false), FLASH_DURATION_MS);
      lastSig.current = sig;
      return () => window.clearTimeout(timer);
    }
    lastSig.current = sig;
  }, [sig]);

  if (!diffStats) return null;
  if (diffStats.added === 0 && diffStats.deleted === 0) return null;

  const eventAtMs = latestEventAt ? Date.parse(latestEventAt) : NaN;
  const stale =
    Number.isFinite(eventAtMs) &&
    eventAtMs > diffStats.computedAt &&
    Date.now() - diffStats.computedAt > STALE_AFTER_MS;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-agent-control="true"
          data-testid="diff-stat-badge"
          onClick={(event) => {
            event.stopPropagation();
            onRefresh();
          }}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] leading-none transition-colors",
            "border-border bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground",
            stale && "opacity-60",
            flash && "border-status-working/60 bg-status-working/15"
          )}
          aria-label="Refresh diff stats"
        >
          <span className="text-status-done">
            +{formatCount(diffStats.added)}
          </span>
          <span className="text-status-blocked">
            −{formatCount(diffStats.deleted)}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <div>
          {diffStats.files} file{diffStats.files === 1 ? "" : "s"} changed
        </div>
        <div className="text-muted-foreground">
          +{diffStats.added} −{diffStats.deleted}
        </div>
        {stale ? (
          <div className="mt-1 text-[10px] text-muted-foreground/80">
            Tap to refresh
          </div>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
