import { useCallback, useEffect, useRef, useState } from "react";

import * as PopoverPrimitive from "@radix-ui/react-popover";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useTip } from "@/lib/tips/use-tip";

import { TipPopoverContent } from "./tip-popover-content";
import { useTipQueue } from "./tip-queue-provider";

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
        sideOffset={sideOffset}
        className="w-auto border-purple-500/20"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <PopoverPrimitive.Arrow
          width={12}
          height={6}
          className="fill-white/20"
        />
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
