import { Sparkles, X } from "lucide-react";

import type { Tip } from "@/lib/tips/tips";

type TipPopoverContentProps = {
  tip: Tip;
  onDismiss: () => void;
  onDisableAll: () => void;
  onOpenDocs?: (section: string) => void;
};

export function TipPopoverContent({
  tip,
  onDismiss,
  onDisableAll,
  onOpenDocs,
}: TipPopoverContentProps) {
  return (
    <div className="max-w-[240px]">
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-purple-400" />
          <span className="text-[13px] font-semibold text-foreground">
            {tip.title}
          </span>
        </div>
        <button
          onClick={onDismiss}
          className="shrink-0 rounded p-0.5 text-muted-foreground/50 transition-colors hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="mb-2.5 text-xs leading-relaxed text-muted-foreground">
        {tip.body}
      </p>
      <div className="flex items-center justify-between">
        {tip.docsSection ? (
          <button
            onClick={() => onOpenDocs?.(tip.docsSection!)}
            className="text-[11px] text-purple-400/80 transition-colors hover:text-purple-300"
          >
            Learn more →
          </button>
        ) : (
          <span />
        )}
        <button
          onClick={onDisableAll}
          className="text-[10px] text-muted-foreground/40 transition-colors hover:text-muted-foreground"
        >
          Don't show tips
        </button>
      </div>
    </div>
  );
}
