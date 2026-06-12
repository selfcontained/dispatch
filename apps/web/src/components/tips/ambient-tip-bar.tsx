import { AnimatePresence, motion } from "framer-motion";
import { Lightbulb, X } from "lucide-react";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { tips, type Tip } from "@/lib/tips/tips";
import { dismissedTipsAtom, tipsEnabledAtom } from "@/lib/tips/tips-state";

const IDLE_DELAY_MS = 2.5 * 60 * 1000; // 2.5 minutes
const SHOW_CHANCE = 0.4;
const AUTO_HIDE_MS = 30_000;

export function AmbientTipBar() {
  const navigate = useNavigate();
  const enabled = useAtomValue(tipsEnabledAtom);
  const dismissed = useAtomValue(dismissedTipsAtom);
  const setDismissed = useSetAtom(dismissedTipsAtom);
  const setEnabled = useSetAtom(tipsEnabledAtom);

  const [visibleTip, setVisibleTip] = useState<Tip | null>(null);
  const shownThisSessionRef = useRef(new Set<string>());
  const hoveredRef = useRef(false);
  const autoHideTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const idleTimerRef = useRef<ReturnType<typeof setTimeout>>();

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
    clearTimeout(autoHideTimerRef.current);
  }, [setEnabled]);

  return (
    <AnimatePresence>
      {visibleTip ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4 }}
          className="border-t border-border/30 bg-background/50 px-5 py-2"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Lightbulb className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
              <span className="truncate text-xs text-muted-foreground">
                <strong className="font-medium text-muted-foreground/80">
                  {visibleTip.title}
                </strong>
                <span className="mx-1.5 opacity-30">—</span>
                {visibleTip.body}
              </span>
              {visibleTip.docsSection ? (
                <button
                  onClick={() =>
                    navigate(`/settings/help/${visibleTip.docsSection}`)
                  }
                  className="shrink-0 text-[11px] text-purple-400/60 transition-colors hover:text-purple-300"
                >
                  Learn more →
                </button>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <button
                onClick={handleDisableAll}
                className="text-[10px] text-muted-foreground/30 transition-colors hover:text-muted-foreground"
              >
                Don't show tips
              </button>
              <button
                onClick={handleDismiss}
                className="rounded p-0.5 text-muted-foreground/30 transition-colors hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
