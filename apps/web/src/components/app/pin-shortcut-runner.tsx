import { type ReactNode, useCallback, useRef, useState } from "react";

import { type AgentPin } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";

/**
 * Confirmation is opt-in per shortcut pin (`confirm: true`) — the owning agent
 * decides which of its own actions deserve a second look before firing.
 */
export function ConfirmShortcutDialog({
  pin,
  onOpenChange,
  onConfirm,
  onRestoreFocus,
}: {
  pin: AgentPin | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  onRestoreFocus?: () => void;
}): JSX.Element {
  return (
    <Dialog open={pin !== null} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="pin-shortcut-confirm-dialog"
        onCloseAutoFocus={(event) => {
          if (!onRestoreFocus) return;
          event.preventDefault();
          onRestoreFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{pin?.label ?? "Run action"}?</DialogTitle>
          <DialogDescription>
            This sends the following prompt to the agent:
          </DialogDescription>
        </DialogHeader>
        <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-background/40 p-2 font-sans text-xs text-foreground">
          {pin?.value}
        </pre>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={pin?.variant === "destructive" ? "destructive" : "primary"}
            onClick={onConfirm}
            data-testid="pin-shortcut-confirm"
          >
            Send
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export type ShortcutRunner<Owner> = {
  /**
   * A shortcut was clicked. Fires `run` at once, or opens the confirmation
   * first when the pin asks for it or the click came from touch.
   */
  request: (
    pin: AgentPin,
    pointerType: string | undefined,
    owner: Owner
  ) => void;
  /** Ref callback for every shortcut button, so focus can return to it. */
  registerButton: (pin: AgentPin, element: HTMLButtonElement | null) => void;
  /** Render once per surface: the confirmation dialog for pending requests. */
  dialog: ReactNode;
};

/**
 * The one way a shortcut pin gets fired, whichever surface shows it — the
 * sidebar and the Chat feed both run their buttons through here, so the
 * confirmation rule and the dialog's focus handling cannot drift between
 * them.
 *
 * On a touch device the hover tooltip never opens — a tap fires the click —
 * so the prompt would be delivered having shown the user only the label.
 * The confirm dialog already renders the full prompt, so touch routes
 * everything through it regardless of the pin's own `confirm` setting.
 *
 * The dialog has no `DialogTrigger` (one instance serves the whole
 * surface), so Radix has nothing to hand focus back to on close — the
 * button that opened it is tracked and focus restored there.
 *
 * `Owner` is whatever the surface needs to know about whose pin it was
 * (the sidebar passes a sub-agent id, the feed nothing).
 */
export function useShortcutRunner<Owner = null>(
  run: (pin: AgentPin, owner: Owner) => void
): ShortcutRunner<Owner> {
  const coarsePointer = useCoarsePointer();
  const [pending, setPending] = useState<{
    pin: AgentPin;
    owner: Owner;
  } | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const lastTrigger = useRef<HTMLButtonElement | null>(null);

  const registerButton = useCallback(
    (pin: AgentPin, element: HTMLButtonElement | null): void => {
      if (!pin.id) return;
      if (element) buttons.current.set(pin.id, element);
      else buttons.current.delete(pin.id);
    },
    []
  );

  const request = useCallback(
    (pin: AgentPin, pointerType: string | undefined, owner: Owner): void => {
      if (pin.confirm || coarsePointer || pointerType === "touch") {
        lastTrigger.current = pin.id
          ? (buttons.current.get(pin.id) ?? null)
          : null;
        setPending({ pin, owner });
        return;
      }
      run(pin, owner);
    },
    [coarsePointer, run]
  );

  const dialog = (
    <ConfirmShortcutDialog
      pin={pending?.pin ?? null}
      onRestoreFocus={() => lastTrigger.current?.focus()}
      onOpenChange={(open) => {
        if (!open) setPending(null);
      }}
      onConfirm={() => {
        if (pending) run(pending.pin, pending.owner);
        setPending(null);
      }}
    />
  );

  return { request, registerButton, dialog };
}
