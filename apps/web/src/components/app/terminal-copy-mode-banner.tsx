import { type JSX } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { type TerminalCopyMode } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type TerminalCopyModeBannerProps = {
  copyMode: TerminalCopyMode | "unknown";
  onExitCopyMode: () => void;
  className?: string;
  compact?: boolean;
  disabled?: boolean;
};

type TerminalCopyModeBannerLayerProps = TerminalCopyModeBannerProps & {
  visible: boolean;
};

export function TerminalCopyModeBannerLayer({
  visible,
  ...props
}: TerminalCopyModeBannerLayerProps): JSX.Element | null {
  return (
    <AnimatePresence initial={false}>
      {visible ? (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
        >
          <TerminalCopyModeBanner {...props} />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export function TerminalCopyModeBanner({
  copyMode,
  onExitCopyMode,
  className,
  compact = false,
  disabled = false,
}: TerminalCopyModeBannerProps): JSX.Element {
  const exiting = copyMode === "exiting";

  return (
    <div
      data-testid="terminal-copy-mode-banner"
      className={cn(
        "pointer-events-none flex items-center justify-between gap-4 border border-primary/35 bg-primary/30 text-foreground",
        compact ? "px-4 py-3" : "px-4 py-3",
        className
      )}
    >
      <div className="min-w-0">
        <p className="text-sm font-semibold">
          {exiting
            ? "Returning to live terminal…"
            : "Scrollback mode. Typing is paused."}
        </p>
        <p className="text-xs text-foreground/75">
          {exiting
            ? "Waiting for tmux to confirm live mode."
            : "Press Esc or return to live."}
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost-primary"
        className="pointer-events-auto shrink-0 rounded-none border border-primary/45 bg-primary/18 text-foreground hover:bg-primary/26"
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onClick={onExitCopyMode}
        disabled={disabled || exiting}
      >
        {exiting ? "Returning…" : "Return to live"}
      </Button>
    </div>
  );
}
