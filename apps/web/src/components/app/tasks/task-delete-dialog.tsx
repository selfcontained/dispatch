import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useTaskActions } from "@/hooks/use-tasks";

/** Mount keyed by task ID so a late deletion cannot close another task. */
export function TaskDeleteDialog({
  task,
  close,
}: {
  task: { id: string; projectId: string; title: string };
  close: () => void;
}) {
  const [target, setTarget] = useState<typeof task | null>(null);
  const { remove } = useTaskActions(task.projectId);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const submitting = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const confirm = async () => {
    if (!target || submitting.current) return;
    submitting.current = true;
    // Keep keyboard events in this scope while both buttons are disabled.
    content.current?.focus();
    try {
      await remove.mutateAsync(target.id);
      if (mounted.current) {
        setTarget(null);
        close();
      }
    } catch {
      // React Query retains the error for an inline retryable message.
    } finally {
      submitting.current = false;
    }
  };

  return (
    <>
      <Button
        ref={trigger}
        size="sm"
        variant="ghost"
        className="ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={() => {
          remove.reset();
          setTarget({ ...task });
        }}
      >
        Delete
      </Button>
      <AlertDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open && !submitting.current) setTarget(null);
        }}
      >
        <AlertDialogContent
          ref={content}
          data-hotkey-disable="true"
          onEscapeKeyDown={(event) => {
            if (submitting.current) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (trigger.current?.isConnected) trigger.current.focus();
          }}
        >
          <AlertDialogTitle className="text-lg font-semibold">
            Delete task?
          </AlertDialogTitle>
          <AlertDialogDescription className="break-words text-sm text-muted-foreground">
            Permanently delete “{target?.title}” and its conversation and
            attachments? This cannot be undone.
          </AlertDialogDescription>
          {remove.error && (
            <p role="alert" className="break-words text-sm text-destructive">
              Could not delete the task: {remove.error.message}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <AlertDialogCancel disabled={remove.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                // Keep the dialog open until the request succeeds.
                event.preventDefault();
                void confirm();
              }}
            >
              {remove.isPending ? "Deleting…" : "Delete task"}
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
