import { TaskLabelPicker } from "./task-labels";
import type { TaskLabel } from "../../../../../server/src/tasks/types";
import { TaskLaunchTemplatePicker } from "./task-launch-template";
import { ContextPicker } from "../context-picker";
import { useStartupAttachments } from "../use-startup-attachments";
import { getClipboardFilesFromEvent } from "../create-agent-dialog-clipboard";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Task, TaskColumn } from "@/hooks/use-tasks";
import { useTaskActions } from "@/hooks/use-tasks";
import type { Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogBody,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
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
import { StatusDot } from "@/components/ui/status-dot";
import { AssigneeSelect } from "./task-assignee-select";
import { columnAccent } from "./task-utils";
import { Alert } from "@/components/ui/alert";
import { Field } from "@/components/ui/field";

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
  const context = useStartupAttachments();
  const formRef = useRef<HTMLFormElement>(null);
  const [launchTemplateId, setLaunchTemplateId] = useState<string | null>(null);
  const [labels, setLabels] = useState<TaskLabel[]>([]);
  const [labelsPending, setLabelsPending] = useState(false);
  const labelsPendingRef = useRef(false);
  const onLabelsPendingChange = useCallback((pending: boolean) => {
    labelsPendingRef.current = pending;
    setLabelsPending(pending);
  }, []);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [column, setColumn] = useState("");
  const [assignee, setAssignee] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>();
  const [saving, setSaving] = useState(false);
  // Created, but the assignment after it failed: retrying only assigns.
  const [created, setCreated] = useState<Task | null>(null);
  useEffect(() => {
    if (!open) return;
    context.resetAttachments();
    setLaunchTemplateId(null);
    setTitle("");
    setLabels([]);
    onLabelsPendingChange(false);
    setBody("");
    setColumn(columnId ?? columns[0]?.id ?? "");
    setAssignee(null);
    setFailure(undefined);
    setCreated(null);
    // Only on opening: a board refetch must not reset the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, columnId]);
  const canSave = Boolean(title.trim()) && !saving && !labelsPending;
  const save = async () => {
    if (!canSave || labelsPendingRef.current) return;
    setSaving(true);
    setFailure(undefined);
    let task = created;
    try {
      task ??= await actions.create.mutateAsync({
        projectId,
        labels,
        title: title.trim(),
        launchTemplateId,
        ...(context.startupFiles.length
          ? { startupFiles: context.startupFiles }
          : {}),
        ...(context.startupLinks.length
          ? { startupLinks: context.startupLinks }
          : {}),
        ...(body.trim() ? { body } : {}),
        ...(column ? { columnId: column } : {}),
      });
    } catch (err) {
      setFailure(err);
      setSaving(false);
      return;
    }
    try {
      // Creating takes no assignee: set it on the new task.
      if (assignee)
        await actions.update.mutateAsync({
          id: task.id,
          assignedAgentId: assignee,
        });
    } catch (err) {
      setCreated(task);
      setFailure(err);
      setSaving(false);
      return;
    }
    setSaving(false);
    onOpenChange(false);
    onCreated(task);
  };
  // Closing after a failed assignment still lands on the task it created.
  const changeOpen = (next: boolean) => {
    onOpenChange(next);
    if (!next && created) onCreated(created);
  };
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            context.setDraggingFiles(true);
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node))
            context.setDraggingFiles(false);
        }}
        onDrop={context.handleStartupDrop}
        data-testid="task-create-dialog"
        phone="fill"
        busy={saving}
      >
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription className="sr-only">
            Title, description, column and assignee for the new task.
          </DialogDescription>
        </DialogHeader>
        <DialogForm
          ref={formRef}
          onPaste={(event) => {
            // ContextPicker owns paste inside its own subtree.
            if (
              (event.target as HTMLElement).closest(
                '[data-testid="task-context"]'
              )
            )
              return;
            const files = getClipboardFilesFromEvent(event);
            if (files.length) {
              event.preventDefault();
              context.appendStartupFiles(files);
            }
          }}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogBody className="space-y-4">
            <Field label="Title" id="task-create-title">
              <Input
                autoFocus
                required
                placeholder="What needs doing?"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
            <Field label="Description" id="task-create-description">
              <Textarea
                placeholder={DESCRIPTION_PLACEHOLDER}
                className="min-h-36 resize-none font-mono text-body-md md:min-h-44"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (event.metaKey || event.ctrlKey)
                  ) {
                    event.preventDefault();
                    formRef.current?.requestSubmit();
                  }
                }}
              />
            </Field>
            <ContextPicker
              error={context.attachmentError}
              files={context.startupFiles}
              links={context.startupLinks}
              draggingFiles={context.draggingFiles}
              filePreviewsRef={context.startupFilePreviewsRef}
              onAppendFiles={context.appendStartupFiles}
              onRemoveFile={context.handleRemoveStartupFile}
              onAddLink={context.handleAddLink}
              onRemoveLink={context.handleRemoveStartupLink}
              testIdPrefix="task-context"
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Column" id="task-create-column">
                <Select value={column} onValueChange={setColumn}>
                  <SelectTrigger aria-label="Column">
                    <SelectValue placeholder="Choose a column" />
                  </SelectTrigger>
                  <SelectContent>
                    {columns.map((item, index) => (
                      <SelectItem key={item.id} value={item.id}>
                        <span className="flex items-center gap-2">
                          <StatusDot
                            color={`hsl(${columnAccent(item, index)})`}
                          />
                          {item.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Assignee">
                <AssigneeSelect
                  value={assignee}
                  agents={agents}
                  projectId={projectId}
                  onChange={setAssignee}
                  className="h-9 max-w-none border-input bg-transparent text-body-md"
                />
              </Field>
            </div>
            <TaskLabelPicker
              key={`${projectId}:${columnId ?? ""}:${open}`}
              onPendingChange={onLabelsPendingChange}
              projectId={projectId}
              value={labels}
              onChange={setLabels}
              disabled={saving || !!created}
            />
            {columns.some((c) => c.trigger) && (
              <TaskLaunchTemplatePicker
                key={open ? "open" : "closed"}
                projectId={projectId}
                value={launchTemplateId}
                onChange={setLaunchTemplateId}
                disabled={saving || !!created}
              />
            )}
          </DialogBody>
          {failure ? (
            <Alert
              title={
                created
                  ? "Task created. Couldn’t assign it."
                  : "Couldn’t create the task."
              }
              error={failure}
            />
          ) : null}
          <DialogFooter
            start={
              <span className="hidden text-body-sm text-muted-foreground md:inline">
                ⌘↵ to create from the description
              </span>
            }
          >
            <DialogCancel />
            <Button
              type="submit"
              variant="primary"
              disabled={!canSave}
              pending={saving}
            >
              {labelsPending
                ? "Restoring label…"
                : created
                  ? "Retry assignment"
                  : "Create task"}
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
