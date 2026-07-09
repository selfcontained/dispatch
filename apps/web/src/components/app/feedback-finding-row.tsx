import { FrontTruncatedValue } from "@/components/app/agent-meta";
import { SEVERITY_DOT, STATUS_LABELS } from "@/components/app/feedback-utils";
import { RoundChip, StatusIcon } from "@/components/app/feedback-shared";
import { type FeedbackItem } from "@/components/app/types";
import { cn } from "@/lib/utils";

export function FeedbackFindingRow({
  item,
  isSelected,
  showRoundDivider,
  onClick,
}: {
  item: FeedbackItem;
  isSelected: boolean;
  showRoundDivider: boolean;
  onClick: () => void;
}): JSX.Element {
  const isActionable = item.status === "open" || item.status === "forwarded";
  const dotColor = SEVERITY_DOT[item.severity] ?? SEVERITY_DOT.info;
  const statusLabel = STATUS_LABELS[item.status];
  const isRecheckItem =
    item.roundNumber >= 2 && item.respondsToFeedbackId != null;

  return (
    <div>
      {showRoundDivider ? (
        <div className="mb-1 mt-2 flex items-center gap-2 px-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
          <span className="h-px flex-1 bg-border/70" />
          <span>Round 2 findings</span>
          <span className="h-px flex-1 bg-border/70" />
        </div>
      ) : null}
      <button
        className={cn(
          "flex w-full flex-col gap-0.5 rounded-md px-1.5 py-1.5 text-left text-[11px] transition-colors",
          "border-b-2",
          isRecheckItem && "ml-4 border-l border-border/60 pl-3",
          !isActionable && "opacity-40",
          isSelected ? "border-primary" : "border-transparent hover:bg-muted/40"
        )}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
      >
        <div className="flex w-full items-center gap-2">
          <RoundChip roundNumber={item.roundNumber} />
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotColor)} />
          <div className="min-w-0 overflow-hidden font-mono text-muted-foreground">
            <FrontTruncatedValue
              value={
                item.filePath
                  ? `${item.filePath.split("/").pop()}${item.lineNumber ? `:${item.lineNumber}` : ""}`
                  : "—"
              }
              mono
            />
          </div>
          <span className="min-w-0 flex-1 truncate text-foreground">
            {item.description}
          </span>
          {statusLabel && !isActionable ? (
            <span
              className={cn("shrink-0", statusLabel.color)}
              title={statusLabel.label}
            >
              <StatusIcon status={item.status} className={statusLabel.color} />
            </span>
          ) : null}
        </div>
        {isRecheckItem ? (
          <div className="ml-8 text-[10px] text-muted-foreground/70">
            Follow-up to round-1 finding #{item.respondsToFeedbackId}
          </div>
        ) : null}
        {!isActionable && item.resolutionReason ? (
          <div
            className="ml-4 truncate pl-0.5 text-[10px] italic text-muted-foreground/70"
            title={item.resolutionReason}
          >
            {item.resolutionReason}
          </div>
        ) : null}
      </button>
    </div>
  );
}
