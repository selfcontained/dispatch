import { useRef, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  makeIdempotencyKey,
  useSubmitSurfaceInteraction,
} from "@/hooks/use-agent-surfaces";
import type { ActionRef } from "@/components/app/agent-surfaces/types";
import {
  ActionRefButton,
  actionButtonVariant,
} from "@/components/app/agent-surfaces/blocks/action-ref-button";
import { ActionConfirmDialog } from "@/components/app/agent-surfaces/blocks/action-confirm-dialog";
import { ActionFeedback } from "@/components/app/agent-surfaces/blocks/interaction-status-caption";
import {
  IDLE_INTERACTION_STATE,
  useKeyedInteractionState,
} from "@/components/app/agent-surfaces/local-interaction-state";
import {
  findInteraction,
  resolveInteractionPresentation,
  type InteractionPresentation,
  type SurfaceInteractionIndex,
} from "@/components/app/agent-surfaces/interaction-presentation";

/**
 * Renders a slot's actions (document footer or section footer) under the
 * renderer-owned emphasis policy:
 *
 * - one action → one compact button;
 * - two actions, neither destructive → two compact buttons;
 * - otherwise → a split button: the main verb plus a chevron menu holding
 *   the rest, destructive verbs last. A destructive action never renders as
 *   a standalone loud button while quieter verbs exist — an irreversible
 *   verb should be findable, not the brightest object on screen.
 *
 * The main verb is the slot's `primary` action when one exists, else its
 * first non-destructive action, else (all-destructive slot) the first action.
 */
export function SlotActions({
  blockId,
  actions,
  agentId,
  surfaceId,
  surfaceRevision,
  interactions,
  onRequestRefresh,
  readOnly,
  idPrefix,
}: {
  /** Interaction address: a section id, or the reserved "footer". */
  blockId: string;
  actions: ActionRef[];
  agentId: string;
  surfaceId: string;
  surfaceRevision: number;
  interactions: SurfaceInteractionIndex;
  onRequestRefresh: () => Promise<void>;
  readOnly: boolean;
  idPrefix: string;
}): JSX.Element {
  const [confirmAction, setConfirmAction] = useState<ActionRef | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  // When a confirm dialog opens from a menu item, that item unmounts as the
  // menu closes, so the dialog's captured activeElement is useless — return
  // focus to the split trigger instead.
  const confirmReturnRef = useRef<HTMLElement | null>(null);
  const mutation = useSubmitSurfaceInteraction(agentId, surfaceId);
  const { states, submit, clear } = useKeyedInteractionState(
    surfaceRevision,
    mutation.mutate
  );

  const presentationOf = (action: ActionRef): InteractionPresentation =>
    resolveInteractionPresentation({
      local: states[action.id] ?? IDLE_INTERACTION_STATE,
      durable: findInteraction(interactions, blockId, action.id),
      surfaceRevision,
      mode: "action",
      readOnly,
    });

  const runAction = (action: ActionRef) => {
    submit(
      action.id,
      {
        idempotencyKey: makeIdempotencyKey(),
        kind: "action",
        blockId,
        actionId: action.id,
        baseRevision: surfaceRevision,
      },
      "Couldn't send this action"
    );
  };

  const handleClick = (action: ActionRef, fromMenu = false) => {
    if (action.disabled || readOnly) return;
    if (presentationOf(action).locked) return;
    if (action.confirm) {
      confirmReturnRef.current = fromMenu ? menuTriggerRef.current : null;
      setConfirmAction(action);
      return;
    }
    runAction(action);
  };

  const main =
    actions.find((action) => action.style === "primary") ??
    actions.find((action) => action.style !== "destructive") ??
    actions[0];
  const rest = actions.filter((action) => action.id !== main.id);
  const menuNeeded =
    rest.length > 1 || rest.some((action) => action.style === "destructive");
  const menuActions = menuNeeded
    ? [
        ...rest.filter((action) => action.style !== "destructive"),
        ...rest.filter((action) => action.style === "destructive"),
      ]
    : [];
  const hasDestructiveSeparator =
    menuActions.some((action) => action.style === "destructive") &&
    menuActions.some((action) => action.style !== "destructive");
  const mainPresentation = presentationOf(main);
  const anyMenuBusy = menuActions.some((action) => presentationOf(action).busy);

  return (
    <div data-slot-actions={blockId}>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {menuNeeded ? (
          <div className="flex items-stretch">
            <ActionRefButton
              action={main}
              className="rounded-r-none"
              busy={mainPresentation.busy}
              disabled={mainPresentation.locked}
              authoredDisabled={!!main.disabled}
              onClick={() => handleClick(main)}
            />
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <Button
                  ref={menuTriggerRef}
                  type="button"
                  size="sm"
                  variant={actionButtonVariant(main.style)}
                  aria-label="More actions"
                  className="h-7 rounded-l-none border-l border-l-white/20 px-1.5 [@media(pointer:coarse)]:min-h-11"
                  disabled={readOnly}
                >
                  {anyMenuBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                // Claim the Escape so an enclosing drawer/dialog doesn't
                // also dismiss; close the menu ourselves since preventing
                // default suppresses Radix's own close.
                onEscapeKeyDown={(event) => {
                  event.preventDefault();
                  setMenuOpen(false);
                }}
              >
                {menuActions.map((action, index) => {
                  const presentation = presentationOf(action);
                  const destructive = action.style === "destructive";
                  const reasonId = `${idPrefix}-${blockId}-${action.id}-menu-reason`;
                  const authoredDisabled = !!action.disabled;
                  return (
                    <div key={action.id}>
                      {destructive &&
                      hasDestructiveSeparator &&
                      menuActions[index - 1]?.style !== "destructive" ? (
                        <DropdownMenuSeparator />
                      ) : null}
                      <DropdownMenuItem
                        // Only transient/system lockout uses native
                        // disabled; an authored disable stays focusable via
                        // aria-disabled so keyboard and touch users can
                        // reach the item and hear its reason.
                        disabled={presentation.locked}
                        aria-disabled={
                          !presentation.locked && authoredDisabled
                            ? true
                            : undefined
                        }
                        aria-describedby={
                          authoredDisabled && action.disabledReason
                            ? reasonId
                            : undefined
                        }
                        className={cn(
                          "flex-col items-start text-xs [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:justify-center",
                          destructive
                            ? "text-status-blocked focus:text-status-blocked"
                            : "text-foreground",
                          authoredDisabled && "opacity-50"
                        )}
                        data-action-id={action.id}
                        onSelect={(event) => {
                          if (authoredDisabled) {
                            // Keep the menu open so the reason stays
                            // readable instead of vanishing on tap.
                            event.preventDefault();
                            return;
                          }
                          handleClick(action, true);
                        }}
                      >
                        <span className="flex items-center">
                          {presentation.busy ? (
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          ) : null}
                          {action.label}
                        </span>
                        {authoredDisabled && action.disabledReason ? (
                          <span
                            id={reasonId}
                            className="text-[10px] font-normal text-muted-foreground"
                          >
                            {action.disabledReason}
                          </span>
                        ) : null}
                      </DropdownMenuItem>
                    </div>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : (
          [main, ...rest].map((action) => {
            const presentation = presentationOf(action);
            return (
              <ActionRefButton
                key={action.id}
                action={action}
                busy={presentation.busy}
                disabled={presentation.locked}
                authoredDisabled={!!action.disabled}
                onClick={() => handleClick(action)}
              />
            );
          })
        )}
      </div>
      {actions.map((action) => {
        const presentation = presentationOf(action);
        if (!presentation.caption && !action.disabled) return null;
        return (
          <div key={action.id} className="text-right">
            <ActionFeedback
              id={`${idPrefix}-${blockId}-${action.id}-disabled-reason`}
              caption={presentation.caption}
              disabled={!!action.disabled}
              disabledReason={action.disabledReason}
              onReload={() => {
                void onRequestRefresh().then(() => clear(action.id));
              }}
            />
          </div>
        );
      })}
      <ActionConfirmDialog
        action={confirmAction}
        returnFocusRef={confirmReturnRef}
        onCancel={() => setConfirmAction(null)}
        onConfirm={(action) => {
          setConfirmAction(null);
          runAction(action);
        }}
      />
    </div>
  );
}
