import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { Markdown } from "@/components/ui/markdown";
import type { SurfaceSectionBlock } from "@/components/app/agent-surfaces/types";
import { BlockHeader } from "@/components/app/agent-surfaces/blocks/block-header";

/**
 * A visual group for related blocks. Collapsible sections keep their controlled
 * region mounted so the disclosure relationship and nested component state
 * remain intact in both states.
 */
export function SectionBlockView({
  block,
  children,
}: {
  block: SurfaceSectionBlock;
  children: ReactNode;
}): JSX.Element {
  const contentId = useId();
  const collapsible = block.collapse !== undefined;
  const [expanded, setExpanded] = useState(!block.collapse?.initiallyCollapsed);

  return (
    <section data-block-id={block.id} data-block-type="section">
      {collapsible ? (
        <div className="mb-1.5">
          <h3>
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={contentId}
              onClick={() => setExpanded((value) => !value)}
              className="flex min-h-11 w-full items-center gap-1.5 rounded-md px-1 text-left text-xs font-semibold text-foreground outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            >
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                  !expanded && "-rotate-90"
                )}
              />
              <span>{block.title}</span>
            </button>
          </h3>
          {block.description ? (
            <Markdown variant="caption" className="ml-1.5 line-clamp-none">
              {block.description}
            </Markdown>
          ) : null}
        </div>
      ) : (
        <BlockHeader title={block.title} description={block.description} />
      )}
      <div
        id={collapsible ? contentId : undefined}
        hidden={collapsible && !expanded}
        className="ml-1.5 border-l border-border/60 pl-2.5"
      >
        <div className="space-y-4">{children}</div>
      </div>
    </section>
  );
}
