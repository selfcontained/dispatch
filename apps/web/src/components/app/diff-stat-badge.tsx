import { useEffect, useRef, useState } from "react";
import SlotCounter from "react-slot-counter";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { DiffStats } from "@/components/app/types";
import { cn } from "@/lib/utils";

const STALE_AFTER_MS = 30_000;
const FLASH_DURATION_MS = 600;
const slotCounterProps = {
  animateUnchanged: false,
  useMonospaceWidth: true,
  hasInfiniteList: true,
  duration: 0.45,
  delay: 0.04,
  dummyCharacterCount: 0,
  containerClassName: "inline-flex items-center",
  charClassName: "h-[1em]",
  numberClassName: "tabular-nums",
  separatorClassName: "tabular-nums",
} as const;

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

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setPrefersReducedMotion(mediaQuery.matches);

    updatePreference();
    mediaQuery.addEventListener("change", updatePreference);

    return () => mediaQuery.removeEventListener("change", updatePreference);
  }, []);

  return prefersReducedMotion;
}

export function DiffStatBadge({
  diffStats,
  latestEventAt,
  onRefresh,
}: DiffStatBadgeProps): JSX.Element | null {
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef<number | null>(null);
  const lastSig = useRef<string | null>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  const sig = diffStats ? `${diffStats.added}:${diffStats.deleted}` : null;

  const triggerFlash = () => {
    if (flashTimer.current !== null) {
      window.clearTimeout(flashTimer.current);
    }

    setFlash(true);
    flashTimer.current = window.setTimeout(() => {
      setFlash(false);
      flashTimer.current = null;
    }, FLASH_DURATION_MS);
  };

  useEffect(() => {
    if (sig === null) {
      lastSig.current = null;
      return;
    }
    if (lastSig.current !== null && lastSig.current !== sig) {
      triggerFlash();
      lastSig.current = sig;
      return;
    }
    lastSig.current = sig;
  }, [sig]);

  useEffect(
    () => () => {
      if (flashTimer.current !== null) {
        window.clearTimeout(flashTimer.current);
      }
    },
    []
  );

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
            triggerFlash();
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
          <span className="inline-flex items-center tabular-nums text-status-working">
            <span>+</span>
            {prefersReducedMotion ? (
              <span>{diffStats.added}</span>
            ) : (
              <SlotCounter
                value={diffStats.added}
                direction="bottom-up"
                {...slotCounterProps}
              />
            )}
          </span>
          <span className="inline-flex items-center tabular-nums text-status-blocked">
            <span>−</span>
            {prefersReducedMotion ? (
              <span>{diffStats.deleted}</span>
            ) : (
              <SlotCounter
                value={diffStats.deleted}
                direction="top-down"
                {...slotCounterProps}
              />
            )}
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
