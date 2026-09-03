import { Markdown } from "@/components/ui/markdown";
import { cn } from "@/lib/utils";
import type { StatusBlock } from "@/components/app/agent-surfaces/types";
import { BlockHeader } from "@/components/app/agent-surfaces/blocks/block-header";
import { formatSurfaceTime } from "@/components/app/agent-surfaces/format";
import { TONE_CLASSES } from "@/components/app/agent-surfaces/tone";

/** A plain readout, not a bordered box — status is informational, and a
 * rounded/bordered container reads too much like a button or input field. A
 * tone dot plus text keeps the non-interactive signal clear. The timestamp
 * sits inline after the status label (relative, absolute on hover) so the
 * least important datum on the row never pulls the eye across empty space. */
export function StatusBlockView({
  block,
}: {
  block: StatusBlock;
}): JSX.Element {
  const tone = block.tone ?? "neutral";
  const time = block.timestamp ? formatSurfaceTime(block.timestamp) : null;
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
          <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
            <span
              className={cn("text-xs font-semibold", TONE_CLASSES[tone].text)}
            >
              {block.status}
            </span>
            {time ? (
              <time
                dateTime={block.timestamp}
                title={time.absolute}
                className="shrink-0 text-[10px] text-muted-foreground"
              >
                · {time.text}
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
