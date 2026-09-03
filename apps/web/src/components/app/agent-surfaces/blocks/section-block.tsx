import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { Markdown } from "@/components/ui/markdown";
import type { SurfaceSectionBlock } from "@/components/app/agent-surfaces/types";
import { SlotActions } from "@/components/app/agent-surfaces/blocks/slot-actions";
import type { SurfaceInteractionIndex } from "@/components/app/agent-surfaces/interaction-presentation";

/**
 * A visual group for related blocks. The title renders as a container label
 * (small caps, muted) so it reads as structure rather than content and never
 * competes with the titles inside it. Collapsed and expanded states share one
 * vocabulary — the left rail and label are constant; the chevron is an
 * affordance on the label, not a different component. The controlled region
 * stays mounted so nested component state survives a collapse.
 *
 * `actions` is the section's footer slot: verbs scoped to this group render
 * right-aligned at its bottom edge, adjacent to what they act on.
 */
export function SectionBlockView({
  block,
  children,
  agentId,
  surfaceId,
  surfaceRevision,
  interactions,
  onRequestRefresh,
  readOnly,
  idPrefix,
}: {
  block: SurfaceSectionBlock;
  children: ReactNode;
  agentId: string;
  surfaceId: string;
  surfaceRevision: number;
  interactions: SurfaceInteractionIndex;
  onRequestRefresh: () => Promise<void>;
  readOnly: boolean;
  idPrefix: string;
}): JSX.Element {
  const contentId = useId();
  const collapsible = block.collapse !== undefined;
  const [expanded, setExpanded] = useState(!block.collapse?.initiallyCollapsed);

  const label = (
    <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
      {block.title}
    </span>
  );

  return (
    <section data-block-id={block.id} data-block-type="section">
      <div className="mb-1">
        {collapsible ? (
          <h3>
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={contentId}
              onClick={() => setExpanded((value) => !value)}
              className="flex min-h-7 w-full items-center gap-1 rounded-md px-1 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 [@media(pointer:coarse)]:min-h-11"
            >
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
                  !expanded && "-rotate-90"
                )}
              />
              {label}
            </button>
          </h3>
        ) : (
          <h3 className="px-1">{label}</h3>
        )}
        {block.description ? (
          <Markdown variant="caption" className="ml-1 line-clamp-none">
            {block.description}
          </Markdown>
        ) : null}
      </div>
      <div
        id={collapsible ? contentId : undefined}
        hidden={collapsible && !expanded}
        className="ml-1 border-l border-border/60 pl-2.5"
      >
        <div className="space-y-4">{children}</div>
        {block.actions?.length ? (
          <div className="mt-2">
            <SlotActions
              blockId={block.id}
              actions={block.actions}
              agentId={agentId}
              surfaceId={surfaceId}
              surfaceRevision={surfaceRevision}
              interactions={interactions}
              onRequestRefresh={onRequestRefresh}
              readOnly={readOnly}
              idPrefix={idPrefix}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
