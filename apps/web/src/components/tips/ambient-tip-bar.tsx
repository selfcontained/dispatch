import { AnimatePresence, motion } from "framer-motion";
import { Lightbulb } from "lucide-react";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { tips, type Tip } from "@/lib/tips/tips";
import { dismissedTipsAtom, tipsEnabledAtom } from "@/lib/tips/tips-state";
import { cn } from "@/lib/utils";

const IDLE_DELAY_MS = 2.5 * 60 * 1000; // 2.5 minutes
const SHOW_CHANCE = 0.4;
const AUTO_HIDE_MS = 30_000;
const ALL_SEEN_MS = 5_000;

export function AmbientTipBar() {
  const navigate = useNavigate();
  const enabled = useAtomValue(tipsEnabledAtom);
  const dismissed = useAtomValue(dismissedTipsAtom);
  const setDismissed = useSetAtom(dismissedTipsAtom);
  const setEnabled = useSetAtom(tipsEnabledAtom);

  const [visibleTip, setVisibleTip] = useState<Tip | null>(null);
  const [allSeenMessage, setAllSeenMessage] = useState(false);
  const shownThisSessionRef = useRef(new Set<string>());
  const hoveredRef = useRef(false);
  const autoHideTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const idleTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const allSeenTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const getEligibleTip = useCallback((): Tip | null => {
    const eligible = tips.filter(
      (t) =>
        t.surfaces.includes("ambient") &&
        !dismissed.includes(t.id) &&
        !shownThisSessionRef.current.has(t.id)
    );
    if (eligible.length === 0) return null;
    return eligible[Math.floor(Math.random() * eligible.length)]!;
  }, [dismissed]);

  const startAutoHide = useCallback(() => {
    clearTimeout(autoHideTimerRef.current);
    autoHideTimerRef.current = setTimeout(() => {
      if (!hoveredRef.current) {
        setVisibleTip(null);
      }
    }, AUTO_HIDE_MS);
  }, []);

  const resetIdleTimer = useCallback(() => {
    clearTimeout(idleTimerRef.current);
    if (!enabled || visibleTip) return;

    idleTimerRef.current = setTimeout(() => {
      if (Math.random() > SHOW_CHANCE) {
        resetIdleTimer();
        return;
      }
      const tip = getEligibleTip();
      if (tip) {
        shownThisSessionRef.current.add(tip.id);
        setVisibleTip(tip);
        startAutoHide();
      }
    }, IDLE_DELAY_MS);
  }, [enabled, visibleTip, getEligibleTip, startAutoHide]);

  useEffect(() => {
    if (!enabled) {
      setVisibleTip(null);
      return;
    }

    const onActivity = () => {
      if (visibleTip) return;
      resetIdleTimer();
    };

    resetIdleTimer();
    window.addEventListener("mousemove", onActivity);
    window.addEventListener("keydown", onActivity);

    return () => {
      clearTimeout(idleTimerRef.current);
      clearTimeout(autoHideTimerRef.current);
      window.removeEventListener("mousemove", onActivity);
      window.removeEventListener("keydown", onActivity);
    };
  }, [enabled, visibleTip, resetIdleTimer]);

  const handleMouseEnter = useCallback(() => {
    hoveredRef.current = true;
    clearTimeout(autoHideTimerRef.current);
  }, []);

  const handleMouseLeave = useCallback(() => {
    hoveredRef.current = false;
    if (visibleTip) startAutoHide();
  }, [visibleTip, startAutoHide]);

  const handleDismiss = useCallback(() => {
    if (visibleTip) {
      setDismissed((prev) =>
        prev.includes(visibleTip.id) ? prev : [...prev, visibleTip.id]
      );
    }
    setVisibleTip(null);
    clearTimeout(autoHideTimerRef.current);
    resetIdleTimer();
  }, [visibleTip, setDismissed, resetIdleTimer]);

  const handleDisableAll = useCallback(() => {
    setEnabled(false);
    setVisibleTip(null);
    setAllSeenMessage(false);
    clearTimeout(autoHideTimerRef.current);
    clearTimeout(allSeenTimerRef.current);
  }, [setEnabled]);

  const handleRequestTip = useCallback(() => {
    if (visibleTip || allSeenMessage) return;
    const eligible = tips.filter(
      (t) => t.surfaces.includes("ambient") && !dismissed.includes(t.id)
    );
    if (eligible.length === 0) {
      setAllSeenMessage(true);
      clearTimeout(allSeenTimerRef.current);
      allSeenTimerRef.current = setTimeout(
        () => setAllSeenMessage(false),
        ALL_SEEN_MS
      );
      return;
    }
    const tip = eligible[Math.floor(Math.random() * eligible.length)]!;
    shownThisSessionRef.current.add(tip.id);
    setVisibleTip(tip);
    startAutoHide();
  }, [visibleTip, allSeenMessage, dismissed, startAutoHide]);

  useEffect(() => {
    return () => clearTimeout(allSeenTimerRef.current);
  }, []);

  if (!enabled) return null;

  const showBar = visibleTip || allSeenMessage;

  return (
    <div
      className="flex h-full items-center gap-2 px-4 text-xs text-muted-foreground"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* 1: lightbulb — always in the same spot */}
      <button
        onClick={showBar ? undefined : handleRequestTip}
        title={showBar ? undefined : "Show a tip"}
        className={cn(
          "shrink-0 rounded p-0.5 transition-colors",
          showBar
            ? "cursor-default text-muted-foreground/40"
            : "cursor-pointer text-muted-foreground/20 hover:text-muted-foreground/60"
        )}
      >
        <Lightbulb
          className={cn("h-3.5 w-3.5", allSeenMessage && "text-yellow-500/50")}
        />
      </button>

      {/* 2: tip text — grows, wraps */}
      <AnimatePresence mode="wait">
        {visibleTip ? (
          <motion.span
            key={`tip-${visibleTip.id}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="min-w-0 flex-1"
          >
            <strong className="font-medium text-muted-foreground/80">
              {visibleTip.title}
            </strong>
            <span className="mx-1.5 opacity-30">—</span>
            {visibleTip.body}
            {visibleTip.docsSection ? (
              <button
                onClick={() =>
                  navigate(`/settings/help/${visibleTip.docsSection}`)
                }
                className="ml-1.5 text-purple-400/60 transition-colors hover:text-purple-300"
              >
                Learn more
              </button>
            ) : null}
          </motion.span>
        ) : allSeenMessage ? (
          <motion.span
            key="all-seen"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="min-w-0 flex-1 italic"
          >
            Nothing left to teach you. You're a Dispatch natural.
          </motion.span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
      </AnimatePresence>

      {/* 3: actions — no wrap */}
      <AnimatePresence>
        {visibleTip ? (
          <motion.div
            key="tip-actions"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="flex shrink-0 items-center gap-1"
          >
            <button
              onClick={handleDisableAll}
              className="rounded-sm px-2 py-1 text-[11px] text-muted-foreground/40 transition-colors hover:bg-white/5 hover:text-muted-foreground"
            >
              Disable
            </button>
            <button
              onClick={handleDismiss}
              className="rounded-sm px-2 py-1 text-[11px] text-muted-foreground/40 transition-colors hover:bg-white/5 hover:text-foreground"
            >
              Dismiss
            </button>
          </motion.div>
        ) : allSeenMessage ? (
          <motion.div
            key="seen-actions"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="shrink-0"
          >
            <button
              onClick={() => setAllSeenMessage(false)}
              className="rounded-sm px-2 py-1 text-[11px] text-muted-foreground/40 transition-colors hover:bg-white/5 hover:text-foreground"
            >
              Dismiss
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
