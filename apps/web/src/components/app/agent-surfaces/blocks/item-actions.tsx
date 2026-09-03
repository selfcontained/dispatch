import { useState } from "react";
import { Loader2, MoreHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  makeIdempotencyKey,
  useSubmitSurfaceInteraction,
} from "@/hooks/use-agent-surfaces";
import type { SurfaceItemAction } from "@/components/app/agent-surfaces/types";
import { ActionFeedback } from "@/components/app/agent-surfaces/blocks/interaction-status-caption";
import {
  IDLE_INTERACTION_STATE,
  useKeyedInteractionState,
} from "@/components/app/agent-surfaces/local-interaction-state";
import {
  findInteraction,
  resolveInteractionPresentation,
  type SurfaceInteractionIndex,
} from "@/components/app/agent-surfaces/interaction-presentation";
import { cn } from "@/lib/utils";

/**
 * Actions attached to one authored list item or table row. One action renders
 * as a compact ghost affordance on the item's title row — it adds no item
 * height and brightens on hover; repeating the same verb down a list reads as
 * a column, not a stack of buttons. Two or more collapse into a per-item
 * overflow (⋯) menu.
 */
export function ItemActions({
  actions,
  itemId,
  blockId,
  agentId,
  surfaceId,
  surfaceRevision,
  interactions,
  onRequestRefresh,
  readOnly,
  idPrefix,
  itemLabel,
}: {
  actions: SurfaceItemAction[];
  itemId: string;
  blockId: string;
  agentId: string;
  surfaceId: string;
  surfaceRevision: number;
  interactions: SurfaceInteractionIndex;
  onRequestRefresh: () => Promise<void>;
  readOnly: boolean;
  idPrefix: string;
  /** Accessible context: "<action label> for <itemLabel>". */
  itemLabel?: string;
}): JSX.Element | null {
  const [menuOpen, setMenuOpen] = useState(false);
  const mutation = useSubmitSurfaceInteraction(agentId, surfaceId);
  const { states, submit, clear } = useKeyedInteractionState(
    surfaceRevision,
    mutation.mutate
  );
  if (actions.length === 0) return null;

  const presentationOf = (action: SurfaceItemAction) =>
    resolveInteractionPresentation({
      local: states[`${itemId}:${action.id}`] ?? IDLE_INTERACTION_STATE,
      durable: findInteraction(interactions, blockId, action.id, itemId),
      surfaceRevision,
      mode: "action",
      readOnly,
    });

  const run = (action: SurfaceItemAction) => {
    if (readOnly || presentationOf(action).locked) return;
    submit(
      `${itemId}:${action.id}`,
      {
        idempotencyKey: makeIdempotencyKey(),
        kind: "action",
        blockId,
        itemId,
        actionId: action.id,
        baseRevision: surfaceRevision,
      },
      "Couldn't send this action"
    );
  };

  const feedback = actions.map((action) => {
    const presentation = presentationOf(action);
    if (!presentation.caption) return null;
    return (
      <ActionFeedback
        key={action.id}
        id={`${idPrefix}-${blockId}-${itemId}-${action.id}-disabled-reason`}
        caption={presentation.caption}
        disabled={false}
        disabledReason={undefined}
        onReload={() => {
          void onRequestRefresh().then(() => clear(`${itemId}:${action.id}`));
        }}
      />
    );
  });

  if (actions.length === 1) {
    const action = actions[0];
    const presentation = presentationOf(action);
    return (
      <div className="min-w-0 max-w-full text-right">
        <Button
          type="button"
          size="sm"
          className={cn(
            // Compact but still visibly a button — a bordered chip on the
            // title row, not bare text.
            "h-6 shrink-0 px-2 text-[11px]",
            "[@media(pointer:coarse)]:min-h-11"
          )}
          disabled={presentation.locked}
          aria-label={
            itemLabel ? `${action.label} for ${itemLabel}` : undefined
          }
          data-action-id={action.id}
          onClick={() => run(action)}
        >
          {presentation.busy ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : null}
          {action.label}
        </Button>
        {feedback}
      </div>
    );
  }

  return (
    <div className="min-w-0 max-w-full text-right">
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 w-6 shrink-0 p-0 text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
            aria-label={itemLabel ? `Actions for ${itemLabel}` : "Item actions"}
            disabled={readOnly}
          >
            {actions.some((action) => presentationOf(action).busy) ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <MoreHorizontal className="h-3.5 w-3.5" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          // Claim the Escape so an enclosing drawer/dialog doesn't also
          // dismiss; close the menu ourselves since preventing default
          // suppresses Radix's own close.
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            setMenuOpen(false);
          }}
        >
          {actions.map((action) => {
            const presentation = presentationOf(action);
            return (
              <DropdownMenuItem
                key={action.id}
                disabled={presentation.locked}
                className="flex items-center text-xs text-foreground [@media(pointer:coarse)]:min-h-11"
                data-action-id={action.id}
                onSelect={() => run(action)}
              >
                {presentation.busy ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : null}
                {action.label}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      {feedback}
    </div>
  );
}
