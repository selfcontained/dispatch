import {
  makeIdempotencyKey,
  useSubmitSurfaceInteraction,
} from "@/hooks/use-agent-surfaces";
import type { SurfaceItemAction } from "@/components/app/agent-surfaces/types";
import { ActionRefButton } from "@/components/app/agent-surfaces/blocks/action-ref-button";
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

/** A compact action attached to one authored list item or table row. */
export function ItemAction({
  action,
  itemId,
  blockId,
  agentId,
  surfaceId,
  surfaceRevision,
  interactions,
  onRequestRefresh,
  readOnly,
  idPrefix,
  ariaLabel,
  buttonClassName,
}: {
  action: SurfaceItemAction;
  itemId: string;
  blockId: string;
  agentId: string;
  surfaceId: string;
  surfaceRevision: number;
  interactions: SurfaceInteractionIndex;
  onRequestRefresh: () => Promise<void>;
  readOnly: boolean;
  idPrefix: string;
  ariaLabel?: string;
  buttonClassName?: string;
}): JSX.Element {
  const mutation = useSubmitSurfaceInteraction(agentId, surfaceId);
  const { states, submit, clear } = useKeyedInteractionState(
    surfaceRevision,
    mutation.mutate
  );
  const key = `${itemId}:${action.id}`;
  const presentation = resolveInteractionPresentation({
    local: states[key] ?? IDLE_INTERACTION_STATE,
    durable: findInteraction(interactions, blockId, action.id, itemId),
    surfaceRevision,
    mode: "action",
    readOnly,
  });
  const disabledReasonId = `${idPrefix}-${blockId}-${itemId}-${action.id}-disabled-reason`;

  const run = () => {
    submit(
      key,
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

  return (
    <div className="min-w-0 max-w-full text-right">
      <ActionRefButton
        action={action}
        className={cn(
          "h-auto min-h-7 max-w-full whitespace-normal break-words px-2 py-1 text-[11px]",
          buttonClassName
        )}
        busy={presentation.busy}
        disabled={presentation.locked}
        authoredDisabled={false}
        ariaLabel={ariaLabel}
        onClick={() => {
          if (readOnly) return;
          run();
        }}
      />
      <ActionFeedback
        id={disabledReasonId}
        caption={presentation.caption}
        disabled={false}
        disabledReason={undefined}
        onReload={() => {
          void onRequestRefresh().then(() => clear(key));
        }}
      />
    </div>
  );
}
