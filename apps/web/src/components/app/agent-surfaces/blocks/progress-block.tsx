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
  // Unspecified tone defaults to success — an agent posting a progress bar
  // with no explicit tone is reporting normal, on-track progress.
  const tone = block.tone ?? "success";
  const max = block.max > 0 ? block.max : 1;
  const clamped = Math.min(Math.max(block.value, 0), max);
  const percent = Math.round((clamped / max) * 100);

  return (
    <div data-block-id={block.id} data-block-type="progress">
      <BlockHeader title={block.title} description={block.description} />
      {block.label ? (
        <div className="mb-1 text-[11px] text-muted-foreground">
          {block.label}
        </div>
      ) : null}
      <div
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={block.label ?? block.title ?? "Progress"}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
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
