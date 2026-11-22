import * as React from "react";

import { Alert } from "./alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "./alert-dialog";
import { Button } from "./button";
import { DialogBody, DialogFooter, DialogHeader } from "./dialog";

/**
 * Throw (or reject) to fail. Resolve to `false` to keep the dialog open
 * without an error, as a step to another question does.
 */
type Confirm = () => unknown;

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names the object: "Delete “Docs”?" */
  title: React.ReactNode;
  /** States the consequence. */
  description?: React.ReactNode;
  children?: React.ReactNode;
  /** Repeats the verb: "Delete column". */
  confirmLabel: string;
  onConfirm: Confirm;
  /** "Couldn’t delete the column." */
  errorTitle: string;
  tone?: "danger" | "primary";
  cancelLabel?: string;
  /** A second, safer way to go ahead. It sits before the confirm button. */
  alternative?: { label: string; onConfirm: Confirm; testId?: string };
  confirmDisabled?: boolean;
  /** Still gathering what the question depends on. */
  checking?: boolean;
  /** Where focus goes on close, when what opened it will be gone. */
  returnFocus?: React.RefObject<HTMLElement | null>;
  confirmTestId?: string;
  cancelTestId?: string;
  "data-testid"?: string;
}

/**
 * One question before an action. Cancel has focus, a failure stays in the
 * dialog, and the same button tries again.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  ...props
}: ConfirmDialogProps): JSX.Element {
  const pending = React.useRef(false);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (next || !pending.current) onOpenChange(next);
      }}
    >
      {open ? (
        <ConfirmContent
          pendingRef={pending}
          onDone={() => onOpenChange(false)}
          {...props}
        />
      ) : null}
    </AlertDialog>
  );
}

function ConfirmContent({
  pendingRef,
  onDone,
  title,
  description,
  children,
  confirmLabel,
  onConfirm,
  errorTitle,
  tone = "danger",
  cancelLabel = "Cancel",
  alternative,
  confirmDisabled,
  checking,
  returnFocus,
  confirmTestId,
  cancelTestId,
  "data-testid": testId,
}: Omit<ConfirmDialogProps, "open" | "onOpenChange"> & {
  pendingRef: React.MutableRefObject<boolean>;
  onDone: () => void;
}): JSX.Element {
  const [running, setRunning] = React.useState<"confirm" | "alternative">();
  const [failure, setFailure] = React.useState<{
    error: unknown;
    from: "confirm" | "alternative";
  }>();
  const [asked, setAsked] = React.useState(0);
  const content = React.useRef<HTMLDivElement>(null);
  const cancel = React.useRef<HTMLButtonElement>(null);
  const confirmButton = React.useRef<HTMLButtonElement>(null);
  const alternativeButton = React.useRef<HTMLButtonElement>(null);
  const mounted = React.useRef(false);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingRef.current = false;
    };
  }, [pendingRef]);
  React.useEffect(() => {
    if (!failure) return;
    const button =
      failure.from === "confirm" ? confirmButton : alternativeButton;
    button.current?.focus();
  }, [failure]);

  React.useEffect(() => {
    if (asked) cancel.current?.focus();
  }, [asked]);

  const run = async (from: "confirm" | "alternative", action: Confirm) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setRunning(from);
    setFailure(undefined);
    // Keep keys in the dialog while its buttons are disabled.
    content.current?.focus();
    try {
      const result = await action();
      // A late answer must not close whatever replaced this question.
      if (!mounted.current) return;
      pendingRef.current = false;
      setRunning(undefined);
      if (result !== false) onDone();
      // Another question took this one's place, so it gets the safe focus.
      else setAsked((count) => count + 1);
    } catch (error) {
      if (!mounted.current) return;
      pendingRef.current = false;
      setRunning(undefined);
      setFailure({ error, from });
    }
  };

  return (
    <AlertDialogContent
      ref={content}
      data-testid={testId}
      aria-busy={running ? true : undefined}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        cancel.current?.focus();
      }}
      onEscapeKeyDown={(event) => {
        if (pendingRef.current) event.preventDefault();
      }}
      onCloseAutoFocus={(event) => {
        if (!returnFocus?.current?.isConnected) return;
        event.preventDefault();
        returnFocus.current.focus();
      }}
      {...(description ? {} : { "aria-describedby": undefined })}
    >
      <DialogHeader className="pr-0 pointer-coarse:pr-0">
        <AlertDialogTitle>{title}</AlertDialogTitle>
        {description ? (
          <AlertDialogDescription>{description}</AlertDialogDescription>
        ) : null}
      </DialogHeader>
      {children ? (
        <DialogBody className="space-y-3">{children}</DialogBody>
      ) : null}
      {failure ? <Alert title={errorTitle} error={failure.error} /> : null}
      <DialogFooter>
        <AlertDialogCancel
          ref={cancel}
          disabled={Boolean(running)}
          data-testid={cancelTestId}
        >
          {cancelLabel}
        </AlertDialogCancel>
        {alternative ? (
          <Button
            ref={alternativeButton}
            type="button"
            wrap
            pending={running === "alternative"}
            disabled={Boolean(running)}
            data-testid={alternative.testId}
            onClick={() => void run("alternative", alternative.onConfirm)}
          >
            {alternative.label}
          </Button>
        ) : null}
        <Button
          ref={confirmButton}
          type="button"
          wrap
          variant={tone}
          pending={running === "confirm" || checking}
          disabled={Boolean(running) || confirmDisabled}
          data-testid={confirmTestId}
          onClick={() => void run("confirm", onConfirm)}
        >
          {confirmLabel}
        </Button>
      </DialogFooter>
    </AlertDialogContent>
  );
}
