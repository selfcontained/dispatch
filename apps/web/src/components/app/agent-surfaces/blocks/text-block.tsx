import { Markdown } from "@/components/ui/markdown";
import type { TextBlock } from "@/components/app/agent-surfaces/types";
import { BlockHeader } from "@/components/app/agent-surfaces/blocks/block-header";

export function TextBlockView({ block }: { block: TextBlock }): JSX.Element {
  return (
    <div data-block-id={block.id} data-block-type="text">
      <BlockHeader title={block.title} description={block.description} />
      <Markdown variant="pin" className="text-foreground/90">
        {block.text}
      </Markdown>
    </div>
  );
}
