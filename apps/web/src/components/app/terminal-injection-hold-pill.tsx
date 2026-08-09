import { useEffect, useState, type JSX, type MutableRefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Mail } from "lucide-react";

import { type InjectionHoldState } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const RING_SIZE = 36;
const RING_RADIUS = 16;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

// Badge shown while the server is holding an automated prompt injection
// because the user is actively typing in the terminal. State arrives via the
// `agent.injection_hold_changed` SSE event (written into the
// ["injection-hold", agentId] query by use-sse). The ring fills clockwise as
// the quiet window elapses — keystrokes and scrolls reset it, mirroring the
// server-side gate. Pointer devices: hover explains, click sends now. Touch:
// tap opens a popover with the explanation and an explicit "Send now" button.
export function TerminalInjectionHoldPill({
  agentId,
  terminalInputAtRef,
  className,
}: {
  agentId: string | null;
  // Timestamp of the user's last local terminal interaction (use-terminal).
  terminalInputAtRef?: MutableRefObject<number>;
  className?: string;
}): JSX.Element {
  const { data } = useQuery<InjectionHoldState>({
    queryKey: ["injection-hold", agentId],
    // No fetch endpoint — the cache is populated by SSE events; this default
    // only seeds first render. A reload during an active hold misses the
    // indicator until the next transition, which fails safe (hidden).
    queryFn: () => ({ held: false, pendingCount: 0, quietMs: 10_000 }),
    enabled: agentId !== null,
    refetchOnWindowFocus: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const reduceMotion = useReducedMotion();
  const [coarsePointer] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(pointer: coarse)").matches
  );
  const [popoverOpen, setPopoverOpen] = useState(false);

  const visible = Boolean(agentId && data?.held);
  const count = data?.pendingCount ?? 0;
  const quietMs = data?.quietMs ?? 10_000;

  // Ring progress: how much of the quiet window has elapsed since the last
  // local interaction. Ticks only while the badge is visible.
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (!visible) {
      setProgress(0);
      return;
    }
    const tick = () => {
      const lastInput = terminalInputAtRef?.current ?? 0;
      if (!lastInput) {
        // Hold caused by activity this client can't see (another viewer);
        // no local ETA to show — render the ring full.
        setProgress(1);
        return;
      }
      setProgress(Math.min(1, (Date.now() - lastInput) / quietMs));
    };
    tick();
    const timer = setInterval(tick, 100);
    return () => clearInterval(timer);
  }, [visible, quietMs, terminalInputAtRef]);

  useEffect(() => {
    if (!visible) {
      setPopoverOpen(false);
    }
  }, [visible]);

  const sendNow = () => {
    if (!agentId) return;
    setPopoverOpen(false);
    void api(`/api/v1/agents/${agentId}/terminal/release-injections`, {
      method: "POST",
    }).catch(() => undefined);
  };

  const waitingLabel =
    count > 1 ? `${count} messages waiting` : "Message waiting";
  const label = coarsePointer
    ? `${waitingLabel} · sends when you pause · tap for options`
    : `${waitingLabel} · sends when you pause · click to send now`;

  // Touch targets get a 44px hit area around the 36px visual.
  const buttonSize = coarsePointer ? 44 : RING_SIZE;

  const badgeButton = (
    <motion.button
      type="button"
      aria-label={label}
      data-testid="terminal-injection-hold-pill"
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
      animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      onMouseDown={(event) => {
        // Don't steal focus from the terminal the user is typing in.
        event.preventDefault();
      }}
      onClick={coarsePointer ? undefined : sendNow}
      className={cn(
        "pointer-events-auto relative grid place-items-center rounded-full",
        "transition-transform hover:scale-105 motion-reduce:transition-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      style={{ width: buttonSize, height: buttonSize }}
    >
      <svg
        aria-hidden
        width={RING_SIZE}
        height={RING_SIZE}
        viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      >
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          fill="none"
          stroke="hsl(var(--status-done) / 0.25)"
          strokeWidth="2.5"
        />
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          fill="none"
          stroke="hsl(var(--status-done))"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - progress)}
          transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
          style={{
            transition: "stroke-dashoffset 120ms linear",
          }}
        />
      </svg>
      <span
        className="absolute grid place-items-center rounded-full"
        style={{
          width: 26,
          height: 26,
          background: "hsl(var(--status-done))",
          color: "hsl(var(--background))",
          boxShadow: "0 2px 10px rgba(0,0,0,0.45)",
        }}
      >
        <Mail className="h-3.5 w-3.5" strokeWidth={2.25} />
      </span>
      {count > 1 ? (
        <span
          className="absolute right-0 top-0 grid h-4 min-w-4 place-items-center rounded-full px-0.5 text-[10px] font-semibold leading-none"
          style={{
            background: "hsl(var(--card))",
            color: "hsl(var(--status-done))",
            boxShadow: "0 0 0 1px hsl(var(--status-done) / 0.6)",
          }}
        >
          {count}
        </span>
      ) : null}
    </motion.button>
  );

  return (
    <>
      {/* Screen-reader announcement when a hold starts — focus is usually in
          the terminal, so the badge's own label is never reached. */}
      <span className="sr-only" role="status" aria-live="polite">
        {visible ? `${waitingLabel} — sends when you pause typing` : ""}
      </span>
      <AnimatePresence initial={false}>
        {visible ? (
          coarsePointer ? (
            <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
              <PopoverTrigger asChild>{badgeButton}</PopoverTrigger>
              <PopoverContent
                side="top"
                align="end"
                className="w-auto max-w-xs p-3"
              >
                <div className="flex flex-col gap-2">
                  <p className="text-xs text-foreground/80">
                    {waitingLabel} — it sends when you pause typing.
                  </p>
                  <Button size="sm" onClick={sendNow}>
                    Send now
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          ) : (
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>{badgeButton}</TooltipTrigger>
                <TooltipContent side="top" align="end">
                  {label}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )
        ) : null}
      </AnimatePresence>
    </>
  );
}
