import { useState } from "react";

import { cn } from "@/lib/utils";
import {
  makeIdempotencyKey,
  useSubmitSurfaceInteraction,
} from "@/hooks/use-agent-surfaces";
import type {
  ActionRef,
  ActionsBlock,
} from "@/components/app/agent-surfaces/types";
import { BlockHeader } from "@/components/app/agent-surfaces/blocks/block-header";
import { ActionRefButton } from "@/components/app/agent-surfaces/blocks/action-ref-button";
import { ActionConfirmDialog } from "@/components/app/agent-surfaces/blocks/action-confirm-dialog";
import {
  ActionFeedback,
  showsDisabledReason,
} from "@/components/app/agent-surfaces/blocks/interaction-status-caption";
import {
  IDLE_INTERACTION_STATE,
  useKeyedInteractionState,
} from "@/components/app/agent-surfaces/local-interaction-state";
import {
  findInteraction,
  resolveInteractionPresentation,
  type SurfaceInteractionIndex,
} from "@/components/app/agent-surfaces/interaction-presentation";

export function ActionsBlockView({
  block,
  agentId,
  surfaceId,
  surfaceRevision,
  interactions,
  onRequestRefresh,
  readOnly,
  idPrefix,
}: {
  block: ActionsBlock;
  agentId: string;
  surfaceId: string;
  surfaceRevision: number;
  interactions: SurfaceInteractionIndex;
  onRequestRefresh: () => Promise<void>;
  readOnly: boolean;
  idPrefix: string;
}): JSX.Element {
  const [confirmAction, setConfirmAction] = useState<ActionRef | null>(null);
  const mutation = useSubmitSurfaceInteraction(agentId, surfaceId);
  const { states, submit, clear } = useKeyedInteractionState(
    surfaceRevision,
    mutation.mutate
  );

  const runAction = (action: ActionRef) => {
    submit(
      action.id,
      {
        idempotencyKey: makeIdempotencyKey(),
        kind: "action",
        blockId: block.id,
        actionId: action.id,
        baseRevision: surfaceRevision,
      },
      "Couldn't send this action"
    );
  };

  const handleClick = (action: ActionRef) => {
    if (action.disabled || readOnly) return;
    if (action.confirm) {
      setConfirmAction(action);
      return;
    }
    runAction(action);
  };

  const layout = block.layout ?? "auto";

  return (
    <div data-block-id={block.id} data-block-type="actions">
      <BlockHeader title={block.title} description={block.description} />
      <div
        className={cn(
          "flex gap-2",
          layout === "stack" ? "flex-col" : "flex-wrap"
        )}
      >
        {block.actions.map((action) => {
          // The durable record is what keeps a queued/claimed action disabled
          // across a reload or sheet remount, and what carries the agent's
          // outcome message once it resolves. Local state only covers the
          // in-flight POST and the gap before the refetch reflects it.
          const presentation = resolveInteractionPresentation({
            local: states[action.id] ?? IDLE_INTERACTION_STATE,
            durable: findInteraction(interactions, block.id, action.id),
            surfaceRevision,
            mode: "action",
            readOnly,
          });
          const authoredDisabled = !!action.disabled;
          const disabledReasonId = `${idPrefix}-${block.id}-${action.id}-disabled-reason`;
          const showsReason = showsDisabledReason(
            presentation.caption,
            authoredDisabled,
            action.disabledReason
          );
          return (
            <div
              key={action.id}
              className={cn(layout === "auto" && "min-w-[45%] flex-1")}
            >
              <ActionRefButton
                action={action}
                className="w-full"
                busy={presentation.busy}
                disabled={presentation.locked}
                authoredDisabled={authoredDisabled}
                disabledReasonId={showsReason ? disabledReasonId : undefined}
                onClick={() => handleClick(action)}
              />
              <ActionFeedback
                id={disabledReasonId}
                caption={presentation.caption}
                disabled={authoredDisabled}
                disabledReason={action.disabledReason}
                onReload={() => {
                  void onRequestRefresh().then(() => clear(action.id));
                }}
              />
            </div>
          );
        })}
      </div>

      <ActionConfirmDialog
        action={confirmAction}
        onCancel={() => setConfirmAction(null)}
        onConfirm={(action) => {
          setConfirmAction(null);
          runAction(action);
        }}
      />
    </div>
  );
}
