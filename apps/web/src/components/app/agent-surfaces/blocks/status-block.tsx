import { Markdown } from "@/components/ui/markdown";
import { cn } from "@/lib/utils";
import type { StatusBlock } from "@/components/app/agent-surfaces/types";
import { BlockHeader } from "@/components/app/agent-surfaces/blocks/block-header";
import { TONE_CLASSES } from "@/components/app/agent-surfaces/tone";

/** A plain readout, not a bordered box — status is informational, and a
 * rounded/bordered container reads too much like a button or input field. A
 * tone dot plus text keeps the non-interactive signal clear. */
export function StatusBlockView({
  block,
}: {
  block: StatusBlock;
}): JSX.Element {
  const tone = block.tone ?? "neutral";
  return (
    <div data-block-id={block.id} data-block-type="status">
      <BlockHeader title={block.title} description={block.description} />
      <div className="flex items-start gap-2">
        <span
          aria-hidden="true"
          className={cn(
            "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
            TONE_CLASSES[tone].dot
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
            <span
              className={cn("text-xs font-semibold", TONE_CLASSES[tone].text)}
            >
              {block.status}
            </span>
            {block.timestamp ? (
              <time
                dateTime={block.timestamp}
                className="shrink-0 text-[10px] text-muted-foreground"
              >
                {new Date(block.timestamp).toLocaleString()}
              </time>
            ) : null}
          </div>
          {block.detail ? (
            <Markdown
              variant="caption"
              className="mt-0.5 text-muted-foreground"
            >
              {block.detail}
            </Markdown>
          ) : null}
        </div>
      </div>
    </div>
  );
}
