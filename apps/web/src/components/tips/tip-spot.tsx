import { useCallback, useEffect, useRef, useState } from "react";

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
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!shouldShowInline || mountedRef.current) return;
    mountedRef.current = true;

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

  if (!tip || !shouldShowInline) {
    return <>{children}</>;
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        sideOffset={sideOffset}
        className="w-auto border-purple-500/20"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
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
