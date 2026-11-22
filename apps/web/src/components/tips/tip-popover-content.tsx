import { Sparkles, X } from "lucide-react";

import type { Tip } from "@/lib/tips/tips";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";

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
        <IconButton size="icon-xs" label="Dismiss tip" onClick={onDismiss}>
          <X />
        </IconButton>
      </div>
      <p className="mb-2 text-body-sm leading-relaxed text-muted-foreground">
        {tip.body}
      </p>
      <div className="flex items-center justify-between">
        {tip.docsSection ? (
          <Button
            size="inline"
            variant="ghost"
            onClick={() => onOpenDocs?.(tip.docsSection!)}
            className="text-label-sm text-status-merged hover:bg-transparent hover:text-status-merged hover:underline"
          >
            Learn more →
          </Button>
        ) : (
          <span />
        )}
        <Button
          size="inline"
          variant="ghost"
          onClick={onDisableAll}
          className="text-label-xs hover:bg-transparent"
        >
          Don't show tips
        </Button>
      </div>
    </div>
  );
}
