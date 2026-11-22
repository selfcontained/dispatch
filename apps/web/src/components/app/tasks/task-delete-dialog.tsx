import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "@/components/ui/toast";
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
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  return (
    <>
      <Button
        ref={trigger}
        size="sm"
        variant="ghost"
        tone="danger"
        onClick={() => setTarget({ ...task })}
      >
        Delete
      </Button>
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        returnFocus={trigger}
        title="Delete task?"
        description={`Permanently delete “${target?.title}” and its conversation and attachments? This cannot be undone.`}
        confirmLabel="Delete task"
        errorTitle="Couldn’t delete the task."
        onConfirm={async () => {
          if (!target) return;
          await remove.mutateAsync(target.id);
          toast.success(`Task “${target.title}” deleted.`);
          if (mounted.current) close();
        }}
      />
    </>
  );
}
