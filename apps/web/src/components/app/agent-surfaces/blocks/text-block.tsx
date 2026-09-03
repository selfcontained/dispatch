import { Markdown } from "@/components/ui/markdown";
import { cn } from "@/lib/utils";
import type { TextBlock } from "@/components/app/agent-surfaces/types";
import { BlockHeader } from "@/components/app/agent-surfaces/blocks/block-header";
import { TONE_CLASSES } from "@/components/app/agent-surfaces/tone";

/** Plain prose by default; a toned text block renders as a callout — the one
 * primitive for "this sentence changes a decision". */
export function TextBlockView({ block }: { block: TextBlock }): JSX.Element {
  const tone = block.tone;
  if (!tone || tone === "neutral") {
    return (
      <div data-block-id={block.id} data-block-type="text">
        <BlockHeader title={block.title} description={block.description} />
        <Markdown variant="pin" className="text-foreground/90">
          {block.text}
        </Markdown>
      </div>
    );
  }
  return (
    <div data-block-id={block.id} data-block-type="text" data-tone={tone}>
      <div
        className={cn(
          "rounded-r-md border-l-2 py-1.5 pl-2.5 pr-2",
          TONE_CLASSES[tone].callout
        )}
      >
        {block.title ? (
          <h3
            className={cn(
              "mb-0.5 text-xs font-semibold",
              TONE_CLASSES[tone].text
            )}
          >
            {block.title}
          </h3>
        ) : null}
        {block.description ? (
          <Markdown variant="caption" className="mb-1 line-clamp-none">
            {block.description}
          </Markdown>
        ) : null}
        <Markdown variant="pin" className="text-foreground/90">
          {block.text}
        </Markdown>
      </div>
    </div>
  );
}
