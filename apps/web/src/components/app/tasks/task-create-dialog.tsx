import { useEffect, useRef, useState } from "react";
import type { Task, TaskColumn } from "@/hooks/use-tasks";
import { useTaskActions } from "@/hooks/use-tasks";
import type { Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AssigneeSelect } from "./task-assignee-select";
import { columnAccent } from "./task-utils";

/** Centered on desktop; the whole screen on a phone. */
export const TASK_DIALOG_MOBILE_SHEET =
  "max-md:inset-0 max-md:left-0 max-md:top-0 max-md:h-[100dvh] max-md:max-h-none max-md:w-full max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none";

const LABEL = "block text-xs font-medium text-muted-foreground";
const DESCRIPTION_PLACEHOLDER = `## Deliverable
What should exist when this is done?

## Acceptance
- How will we know it works?`;

export function TaskCreateDialog({
  open,
  onOpenChange,
  projectId,
  columns,
  agents,
  columnId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  columns: TaskColumn[];
  agents: Agent[];
  /** The column the dialog opens on; the first column otherwise. */
  columnId?: string | null;
  onCreated: (task: Task) => void;
}) {
  const actions = useTaskActions(projectId);
  const formRef = useRef<HTMLFormElement>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [column, setColumn] = useState("");
  const [assignee, setAssignee] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setBody("");
    setColumn(columnId ?? columns[0]?.id ?? "");
    setAssignee(null);
    setError(null);
    // Only on opening: a board refetch must not reset the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, columnId]);
  const canSave = Boolean(title.trim()) && !saving;
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const task = await actions.create.mutateAsync({
        projectId,
        title: title.trim(),
        ...(body.trim() ? { body } : {}),
        ...(column ? { columnId: column } : {}),
      });
      // Creating takes no assignee: set it on the new task.
      if (assignee)
        await actions.update.mutateAsync({
          id: task.id,
          assignedAgentId: assignee,
        });
      onOpenChange(false);
      onCreated(task);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="task-create-dialog"
        className={`md:w-[min(600px,calc(100vw-2rem))] ${TASK_DIALOG_MOBILE_SHEET} max-md:pt-[max(1rem,env(safe-area-inset-top))]`}
      >
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription className="sr-only">
            Title, description, column and assignee for the new task.
          </DialogDescription>
        </DialogHeader>
        <form
          ref={formRef}
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="space-y-1.5">
            <label className={LABEL} htmlFor="task-create-title">
              Title
            </label>
            <Input
              id="task-create-title"
              autoFocus
              required
              placeholder="What needs doing?"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="flex min-h-0 flex-1 flex-col space-y-1.5">
            <label className={LABEL} htmlFor="task-create-description">
              Description
            </label>
            <Textarea
              id="task-create-description"
              placeholder={DESCRIPTION_PLACEHOLDER}
              className="min-h-36 flex-1 resize-none font-mono text-sm md:min-h-44"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  formRef.current?.requestSubmit();
                }
              }}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className={LABEL} htmlFor="task-create-column">
                Column
              </label>
              <Select value={column} onValueChange={setColumn}>
                <SelectTrigger id="task-create-column" aria-label="Column">
                  <SelectValue placeholder="Choose a column" />
                </SelectTrigger>
                <SelectContent>
                  {columns.map((item, index) => (
                    <SelectItem key={item.id} value={item.id}>
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden="true"
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{
                            background: `hsl(${columnAccent(item, index)})`,
                          }}
                        />
                        {item.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <span className={LABEL}>Assignee</span>
              <AssigneeSelect
                value={assignee}
                agents={agents}
                projectId={projectId}
                onChange={setAssignee}
                className="h-9 max-w-none border-input bg-transparent text-sm"
              />
            </div>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="mt-auto flex items-center justify-end gap-2 pb-[env(safe-area-inset-bottom)]">
            <span className="mr-auto hidden text-xs text-muted-foreground md:inline">
              ⌘↵ to create from the description
            </span>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              {saving ? "Creating…" : "Create task"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
