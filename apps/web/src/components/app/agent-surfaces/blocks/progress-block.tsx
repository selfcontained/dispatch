import { Markdown } from "@/components/ui/markdown";
import { cn } from "@/lib/utils";
import type { ProgressBlock } from "@/components/app/agent-surfaces/types";
import { BlockHeader } from "@/components/app/agent-surfaces/blocks/block-header";
import { TONE_CLASSES } from "@/components/app/agent-surfaces/tone";

/** No shadcn progress primitive exists in this repo — hand-rolled per
 * CLAUDE.md's "only hand-roll when there is no suitable shadcn primitive". */
export function ProgressBlockView({
  block,
}: {
  block: ProgressBlock;
}): JSX.Element {
  // Unspecified tone is a neutral fill: a saturated bar reads as interactive
  // (it lands in the same hue as primary buttons), so color is reserved for
  // explicitly authored warning states.
  const tone = block.tone ?? "neutral";
  const max = block.max > 0 ? block.max : 1;
  const clamped = Math.min(Math.max(block.value, 0), max);
  const percent = Math.round((clamped / max) * 100);
  // The label line carries the number; the bar carries the shape. When title
  // and label are both present the label wins the line next to the percent.
  const line = block.label ?? block.title;

  return (
    <div data-block-id={block.id} data-block-type="progress">
      <BlockHeader
        title={block.label ? block.title : undefined}
        description={block.description}
      />
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="min-w-0 text-[11px] text-muted-foreground">
          {line}
        </span>
        <span className="shrink-0 text-[11px] font-medium tabular-nums text-foreground">
          {percent}%
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={block.label ?? block.title ?? "Progress"}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            TONE_CLASSES[tone].bar
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      {block.detail ? (
        <Markdown variant="caption" className="mt-1">
          {block.detail}
        </Markdown>
      ) : null}
    </div>
  );
}
