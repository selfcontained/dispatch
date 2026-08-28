import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ActionRef } from "@/components/app/agent-surfaces/types";
import { actionButtonVariant } from "@/components/app/agent-surfaces/blocks/action-ref-button";

/**
 * Confirmation dialog for an `ActionRef.confirm`-bearing action, shared by
 * actions-block's action buttons and form-block's submit button so
 * confirmation reads and behaves the same wherever it's meaningful.
 */
export function ActionConfirmDialog({
  action,
  onCancel,
  onConfirm,
}: {
  action: ActionRef | null;
  onCancel: () => void;
  onConfirm: (action: ActionRef) => void;
}): JSX.Element {
  // Radix restores focus to whatever was focused before Content mounted —
  // but only when Radix's own Presence controls the mount/unmount. Rendering
  // `<DialogContent>` itself conditionally on `action` unmounts it the same
  // instant `action` goes back to null, bypassing that. Instead we keep
  // rendering the last non-null action while `open` transitions back to
  // false, so Content only ever unmounts through Radix's own close.
  const [lastAction, setLastAction] = useState<ActionRef | null>(action);
  useEffect(() => {
    if (action) setLastAction(action);
  }, [action]);
  // Prefer the live `action` so opening renders synchronously without
  // waiting on the effect above; fall back to the last known one while
  // closing. Before the first open both are null, so nothing renders yet —
  // no empty DialogContent, no missing-Title warning.
  const shownAction = action ?? lastAction;

  // Radix's own onCloseAutoFocus default restores focus to *its* trigger
  // ref, which is only populated by a `<DialogTrigger>` — we don't render
  // one here since the button that opens this dialog lives in the caller
  // (actions-block/form-block), so that default is always a no-op and focus
  // falls through to <body>. `onOpenAutoFocus` fires before Radix moves
  // focus into the content (it's the mount-time counterpart of
  // onCloseAutoFocus, dispatched ahead of Radix's own default-focus step),
  // so capturing `document.activeElement` there reliably gets us the
  // trigger — we don't touch its default behavior, just observe.
  const triggerRef = useRef<HTMLElement | null>(null);

  return (
    <Dialog open={!!action} onOpenChange={(open) => !open && onCancel()}>
      {shownAction ? (
        <DialogContent
          onOpenAutoFocus={() => {
            triggerRef.current =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{shownAction.confirm?.title}</DialogTitle>
            {shownAction.confirm?.description ? (
              <DialogDescription>
                {shownAction.confirm.description}
              </DialogDescription>
            ) : null}
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              variant={actionButtonVariant(shownAction.style)}
              size="sm"
              onClick={() => onConfirm(shownAction)}
            >
              Confirm
            </Button>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
