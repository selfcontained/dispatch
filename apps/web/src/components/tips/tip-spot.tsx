import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useTip } from "@/lib/tips/use-tip";

import { TipPopoverContent } from "./tip-popover-content";
import { useTipQueue } from "./tip-queue-provider";

/** Check if the element is actually reachable (not covered by an overlay). */
function isTriggerReachable(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const topEl = document.elementFromPoint(cx, cy);
  if (!topEl) return false;
  return el.contains(topEl) || el === topEl;
}

function TipArrow({ side, offset }: { side: string; offset?: number }) {
  const isBottom = side === "bottom" || side === "right";
  return (
    <svg
      width="16"
      height="8"
      viewBox="0 0 16 8"
      className="absolute pointer-events-none"
      style={{
        left: offset ?? "50%",
        transform: "translateX(-50%)",
        ...(isBottom
          ? { top: -8, marginTop: 1 }
          : { bottom: -8, marginBottom: 1 }),
      }}
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
  children: React.ReactNode;
};

export function TipSpot({
  tipId,
  side = "right",
  align = "center",
  sideOffset = 8,
  children,
}: TipSpotProps) {
  const navigate = useNavigate();
  const { tip, shouldShowInline, dismiss, disableAll } = useTip(tipId);
  const { requestOpen, release } = useTipQueue();
  const [open, setOpen] = useState(false);
  const eligibleRef = useRef(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [arrowOffset, setArrowOffset] = useState<number | undefined>();

  // Latch eligibility so the popover survives lastSeenVersion updates
  if (shouldShowInline) {
    eligibleRef.current = true;
  }

  // Track whether the trigger is reachable (not covered by an overlay).
  // A single MutationObserver + resize listener drives this state so both
  // the "wait to open" and "close when occluded" paths are event-driven.
  const [triggerReachable, setTriggerReachable] = useState(false);

  useEffect(() => {
    const el = triggerRef.current;
    if (!el || !eligibleRef.current) return;
    let rafId: number | undefined;
    const check = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = undefined;
        setTriggerReachable(isTriggerReachable(el));
      });
    };
    check();
    window.addEventListener("resize", check);
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener("resize", check);
      observer.disconnect();
    };
  }, []);

  // Open the tip once the trigger becomes reachable
  useEffect(() => {
    if (!shouldShowInline || !triggerReachable || open) return;
    const timer = setTimeout(() => {
      if (requestOpen(tipId)) setOpen(true);
    }, 500);
    return () => clearTimeout(timer);
  }, [shouldShowInline, triggerReachable, open, tipId, requestOpen]);

  // Close (without dismissing) when the trigger becomes occluded
  useEffect(() => {
    if (open && !triggerReachable) setOpen(false);
  }, [open, triggerReachable]);

  // Compute arrow offset so it points at the trigger, not the popover center
  useEffect(() => {
    if (!open) {
      setArrowOffset(undefined);
      return;
    }
    const frame = requestAnimationFrame(() => {
      const trigger = triggerRef.current;
      const content = contentRef.current;
      if (!trigger || !content) return;
      const triggerRect = trigger.getBoundingClientRect();
      const contentRect = content.getBoundingClientRect();
      const triggerCenter = triggerRect.left + triggerRect.width / 2;
      setArrowOffset(triggerCenter - contentRect.left);
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

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

  const handleOpenDocs = useCallback(
    (section: string) => {
      handleDismiss();
      navigate(`/settings/help/${section}`);
    },
    [handleDismiss, navigate]
  );

  if (!tip || !eligibleRef.current) {
    return <>{children}</>;
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <span ref={triggerRef} className="inline-flex">
          {children}
        </span>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        side={side}
        align={align}
        sideOffset={sideOffset + 8}
        collisionPadding={8}
        className="tip-popover w-auto border-purple-500/20"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <TipArrow side={side} offset={arrowOffset} />
        <TipPopoverContent
          tip={tip}
          onDismiss={handleDismiss}
          onDisableAll={handleDisableAll}
          onOpenDocs={handleOpenDocs}
        />
      </PopoverContent>
    </Popover>
  );
}
