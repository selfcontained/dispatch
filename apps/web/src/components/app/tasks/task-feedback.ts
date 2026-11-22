import { toast } from "@/components/ui/toast";
import type { Task, useTaskActions } from "@/hooks/use-tasks";

type Actions = Pick<ReturnType<typeof useTaskActions>, "archive" | "restore">;
type Ref = Pick<Task, "id" | "title">;

// mutateAsync, not mutate's callbacks: the card or row that started it is
// gone by the time the board refetch resolves.

/**
 * An archived task leaves the board, so its toast carries Undo. A failure
 * is a toast unless the caller shows it where the action was taken.
 */
export function archiveTask(
  actions: Actions,
  task: Ref,
  { failureShownInline = false } = {}
): void {
  void actions.archive.mutateAsync(task.id).then(
    () => {
      toast.success(`Task “${task.title}” archived.`, {
        action: { label: "Undo", onClick: () => restoreTask(actions, task) },
      });
    },
    (error: unknown) => {
      if (!failureShownInline)
        toast.error(`Couldn’t archive “${task.title}”.`, { error });
    }
  );
}

export function restoreTask(
  actions: Actions,
  task: Ref,
  { failureShownInline = false } = {}
): void {
  void actions.restore.mutateAsync(task.id).then(
    () => {
      toast.success(`Task “${task.title}” restored.`, {
        action: { label: "Undo", onClick: () => archiveTask(actions, task) },
      });
    },
    (error: unknown) => {
      if (!failureShownInline)
        toast.error(`Couldn’t restore “${task.title}”.`, { error });
    }
  );
}
