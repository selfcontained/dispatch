import { memo, useCallback, useState } from "react";

import { TAB_DRAG_MIME } from "@/components/app/center-pane-tab-bar";
import { cn } from "@/lib/utils";

type SplitDropZonesProps = {
  visible: boolean;
  onDrop: (tab: string, side: "left" | "right") => void;
};

export const SplitDropZones = memo(function SplitDropZones({
  visible,
  onDrop,
}: SplitDropZonesProps): JSX.Element | null {
  const [activeSide, setActiveSide] = useState<"left" | "right" | null>(null);

  const handleDragOver = useCallback(
    (e: React.DragEvent, side: "left" | "right") => {
      if (!e.dataTransfer.types.includes(TAB_DRAG_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setActiveSide(side);
    },
    []
  );

  const handleDragLeave = useCallback(() => {
    setActiveSide(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, side: "left" | "right") => {
      e.preventDefault();
      setActiveSide(null);
      const tabId = e.dataTransfer.getData(TAB_DRAG_MIME);
      if (tabId) {
        onDrop(tabId, side);
      }
    },
    [onDrop]
  );

  if (!visible) return null;

  return (
    <div className="absolute inset-0 z-30 flex" data-testid="split-drop-zones">
      <div
        className={cn(
          "flex-1 flex items-center justify-center border-2 border-dashed rounded-l-lg m-2 mr-1 transition-colors",
          activeSide === "left"
            ? "border-ring bg-ring/10"
            : "border-muted-foreground/30 bg-muted/10"
        )}
        onDragOver={(e) => handleDragOver(e, "left")}
        onDragLeave={handleDragLeave}
        onDrop={(e) => handleDrop(e, "left")}
        data-testid="split-drop-left"
      >
        <span
          className={cn(
            "text-sm font-medium uppercase tracking-wide transition-colors",
            activeSide === "left"
              ? "text-foreground"
              : "text-muted-foreground/60"
          )}
        >
          Left
        </span>
      </div>
      <div
        className={cn(
          "flex-1 flex items-center justify-center border-2 border-dashed rounded-r-lg m-2 ml-1 transition-colors",
          activeSide === "right"
            ? "border-ring bg-ring/10"
            : "border-muted-foreground/30 bg-muted/10"
        )}
        onDragOver={(e) => handleDragOver(e, "right")}
        onDragLeave={handleDragLeave}
        onDrop={(e) => handleDrop(e, "right")}
        data-testid="split-drop-right"
      >
        <span
          className={cn(
            "text-sm font-medium uppercase tracking-wide transition-colors",
            activeSide === "right"
              ? "text-foreground"
              : "text-muted-foreground/60"
          )}
        >
          Right
        </span>
      </div>
    </div>
  );
});
