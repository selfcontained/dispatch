import { type JSX } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, Pause } from "lucide-react";

import { type TerminalCopyMode } from "@/components/app/types";
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

const SUNSET_BODY: React.CSSProperties = {
  background:
    "linear-gradient(90deg, hsl(var(--destructive) / 0.07) 0%, hsl(var(--status-waiting) / 0.07) 50%, hsl(var(--primary) / 0.07) 100%)",
  borderColor: "hsl(var(--status-waiting) / 0.40)",
  boxShadow:
    "0 8px 28px rgba(0,0,0,0.35), 0 0 28px hsl(var(--status-waiting) / 0.20), 0 0 28px hsl(var(--destructive) / 0.14), inset 0 1px 0 rgba(255,255,255,0.04)",
};

const SUNSET_ICON_BG = "hsl(var(--status-waiting) / 0.20)";
const SUNSET_ICON_RING = "hsl(var(--status-waiting) / 0.25)";
const SUNSET_ICON_COLOR = "hsl(var(--status-waiting))";

export function TerminalCopyModeBanner({
  copyMode,
  onExitCopyMode,
  className,
  disabled = false,
}: TerminalCopyModeBannerProps): JSX.Element {
  const exiting = copyMode === "exiting";

  // Render the active layout always (with opacity-0 in the exiting state)
  // so the pill keeps a stable width when the message swaps. The exiting
  // message is overlaid via an absolutely positioned span.
  return (
    <button
      type="button"
      data-testid="terminal-copy-mode-banner"
      onClick={onExitCopyMode}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      disabled={disabled || exiting}
      style={SUNSET_BODY}
      className={cn(
        "pointer-events-auto group relative flex w-full items-center justify-center gap-3 whitespace-nowrap rounded-full border py-2.5 px-3 text-foreground",
        "backdrop-blur-[4px]",
        "transition-all hover:brightness-110",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-default disabled:opacity-90 disabled:hover:brightness-100",
        className
      )}
    >
      {/* Content cluster sits centered inside the full-width banner. The
          banner itself spans terminal width (justify-center on the button
          + w-full on its wrapper) so the click/tap target is large, while
          the icon+copy+kbd stay grouped together visually. */}
      <span
        className={cn(
          "flex min-w-0 items-center gap-3 transition-opacity md:gap-5",
          exiting && "opacity-0"
        )}
        aria-hidden={exiting}
      >
        <span
          className="grid h-6 w-6 shrink-0 place-items-center rounded-full"
          style={{
            background: SUNSET_ICON_BG,
            color: SUNSET_ICON_COLOR,
            boxShadow: `inset 0 0 0 1px ${SUNSET_ICON_RING}`,
          }}
        >
          <Pause className="h-3 w-3 fill-current" />
        </span>
        <p className="min-w-0 truncate text-xs font-medium">
          <span className="font-semibold">Input paused</span>
          <span className="px-1.5 text-foreground/40 md:px-2.5">·</span>
          <span className="text-foreground/70">
            scroll
            <ChevronDown
              className="ml-0.5 mr-1.5 inline-block h-3 w-3 align-[-2px] md:mr-2"
              aria-hidden
            />
            <span className="px-1 text-foreground/40 md:px-2">·</span>
            {/* Switch verb based on the user's actual primary input mode
                (touch vs. mouse) instead of viewport width — so it stays
                correct on iPads in landscape, touch-enabled laptops, and
                narrow desktop split views. */}
            <span className="[@media(pointer:fine)]:hidden">tap</span>
            <span className="hidden [@media(pointer:fine)]:inline">click</span>
            <span className="px-1 text-foreground/40 md:px-2">·</span>
          </span>
        </p>
        <kbd
          aria-hidden
          className="shrink-0 rounded border border-foreground/25 bg-foreground/10 px-1.5 py-0.5 text-[10px] font-medium tracking-[0.08em] text-foreground/85 transition-all group-hover:border-foreground/40 group-hover:bg-foreground/15 group-hover:text-foreground"
        >
          Esc
        </kbd>
      </span>

      {/* Exiting message overlays the same width as the active layout.
          aria-hidden when not exiting so screen readers don't announce
          this string alongside the active "Input paused …" copy. */}
      <span
        className={cn(
          "pointer-events-none absolute inset-0 flex items-center justify-center text-xs font-medium tracking-tight transition-opacity",
          exiting ? "opacity-100" : "opacity-0"
        )}
        aria-hidden={!exiting}
        aria-live="polite"
      >
        Returning to live…
      </span>
    </button>
  );
}
