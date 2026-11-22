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
          <Sparkles className="h-3.5 w-3.5 text-status-merged" />
          <span className="text-body-sm font-semibold text-foreground">
            {tip.title}
          </span>
        </div>
        <button
          onClick={onDismiss}
          className="shrink-0 rounded-sm p-0.5 text-faint transition-colors hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="mb-2 text-body-sm leading-relaxed text-muted-foreground">
        {tip.body}
      </p>
      <div className="flex items-center justify-between">
        {tip.docsSection ? (
          <button
            onClick={() => onOpenDocs?.(tip.docsSection!)}
            className="text-label-sm text-status-merged/soft transition-colors hover:text-status-merged"
          >
            Learn more →
          </button>
        ) : (
          <span />
        )}
        <button
          onClick={onDisableAll}
          className="text-label-xs text-faint transition-colors hover:text-muted-foreground"
        >
          Don't show tips
        </button>
      </div>
    </div>
  );
}
