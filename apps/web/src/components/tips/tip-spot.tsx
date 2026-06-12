import { useCallback, useEffect, useRef, useState } from "react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useTip } from "@/lib/tips/use-tip";

import { TipPopoverContent } from "./tip-popover-content";
import { useTipQueue } from "./tip-queue-provider";

function TipArrow({ side }: { side: string }) {
  const isBottom = side === "bottom" || side === "right";
  // Arrow dimensions: 16px wide, 8px tall
  // Polygon fills the arrow interior, open path draws only the two diagonal edges.
  // The SVG is positioned absolutely to overlap the popover border by 1px.
  return (
    <svg
      width="16"
      height="8"
      viewBox="0 0 16 8"
      className="absolute left-1/2 -translate-x-1/2 pointer-events-none"
      style={
        isBottom ? { top: -8, marginTop: 1 } : { bottom: -8, marginBottom: 1 }
      }
    >
      {isBottom ? (
        <>
          <polygon points="0,8 8,0 16,8" fill="hsl(var(--popover))" />
          <path
            d="M0 8 L8 0 L16 8"
            stroke="rgba(168,85,247,0.2)"
            strokeWidth="1"
            fill="none"
          />
        </>
      ) : (
        <>
          <polygon points="0,0 8,8 16,0" fill="hsl(var(--popover))" />
          <path
            d="M0 0 L8 8 L16 0"
            stroke="rgba(168,85,247,0.2)"
            strokeWidth="1"
            fill="none"
          />
        </>
      )}
    </svg>
  );
}

type TipSpotProps = {
  tipId: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  onOpenDocs?: (section: string) => void;
  children: React.ReactNode;
};

export function TipSpot({
  tipId,
  side = "right",
  align = "center",
  sideOffset = 8,
  onOpenDocs,
  children,
}: TipSpotProps) {
  const { tip, shouldShowInline, dismiss, disableAll } = useTip(tipId);
  const { requestOpen, release } = useTipQueue();
  const [open, setOpen] = useState(false);
  const eligibleRef = useRef(false);

  // Latch eligibility so the popover survives lastSeenVersion updates
  if (shouldShowInline) {
    eligibleRef.current = true;
  }

  useEffect(() => {
    if (!shouldShowInline) return;

    const timer = setTimeout(() => {
      if (requestOpen(tipId)) {
        setOpen(true);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [shouldShowInline, tipId, requestOpen]);

  const handleDismiss = useCallback(() => {
    setOpen(false);
    dismiss();
    release(tipId);
  }, [dismiss, release, tipId]);

  const handleDisableAll = useCallback(() => {
    setOpen(false);
    disableAll();
    release(tipId);
  }, [disableAll, release, tipId]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        handleDismiss();
      }
    },
    [handleDismiss]
  );

  if (!tip || !eligibleRef.current) {
    return <>{children}</>;
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <span className="inline-flex">{children}</span>
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        sideOffset={sideOffset + 8}
        className="tip-popover w-auto border-purple-500/20"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <TipArrow side={side} />
        <TipPopoverContent
          tip={tip}
          onDismiss={handleDismiss}
          onDisableAll={handleDisableAll}
          onOpenDocs={onOpenDocs}
        />
      </PopoverContent>
    </Popover>
  );
}
