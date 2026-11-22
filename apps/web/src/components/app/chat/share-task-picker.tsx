import { useState } from "react";
import { ListTodo } from "lucide-react";
import { useTaskBoard, useTaskDetail } from "@/hooks/use-tasks";
import { useProjectScope } from "@/hooks/use-projects";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandItem,
  CommandEmpty,
} from "@/components/ui/command";
import { IconButton } from "@/components/ui/icon-button";

function TaskPicker({ share }: { share: (id: string) => Promise<void> }) {
  const { projectId } = useProjectScope();
  const { data: board, isPending, error: boardError } = useTaskBoard(projectId);
  const [search, setSearch] = useState("");
  const pastedId = /^tsk_[a-f0-9]{12}$/.test(search.trim())
    ? search.trim()
    : null;
  const pasted = useTaskDetail(pastedId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tasks = pastedId
    ? pasted.data
      ? [pasted.data]
      : []
    : (board?.tasks ?? []).filter((task) =>
        task.title.toLowerCase().includes(search.toLowerCase())
      );
  const choose = async (id: string) => {
    setPending(true);
    setError(null);
    try {
      await share(id);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not share task."
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <Command shouldFilter={false}>
      <CommandInput
        placeholder="Search tasks or paste a task ID…"
        value={search}
        onValueChange={setSearch}
      />
      <CommandList aria-label="Share task">
        <CommandEmpty>
          {(pastedId && pasted.isPending) || (projectId && isPending)
            ? "Loading tasks…"
            : pasted.error
              ? "Task unavailable"
              : boardError
                ? "Could not load tasks"
                : !projectId && !pastedId
                  ? "Select a project or paste a task ID"
                  : "No tasks found"}
        </CommandEmpty>
        {tasks.map((task) => (
          <CommandItem
            key={task.id}
            value={task.id}
            disabled={pending}
            onSelect={() => void choose(task.id)}
          >
            {task.title}
          </CommandItem>
        ))}
      </CommandList>
      {error && (
        <p role="alert" className="p-2 text-body-sm text-danger">
          {error}
        </p>
      )}
    </Command>
  );
}

/** Sharing posts immediately, keeping the text/file draft untouched. */
export function ShareTaskPicker({
  disabled,
  onShare,
}: {
  disabled: boolean;
  onShare: (id: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton label="Share task" disabled={disabled}>
          <ListTodo aria-hidden="true" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        className="w-80 max-w-[calc(100vw-2rem)] p-0"
      >
        {open && (
          <TaskPicker
            share={async (id) => {
              await onShare(id);
              setOpen(false);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
