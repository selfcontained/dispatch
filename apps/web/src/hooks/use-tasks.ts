import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Task,
  TaskBoard,
  TaskDetail,
  TaskColumn,
  TaskColumnTrigger,
  CreateTaskInput,
  UpdateTaskInput,
  CreateTaskColumnInput,
  UpdateTaskColumnInput,
  LaunchTaskAgentInput,
} from "../../../server/src/tasks/types";
import { api } from "@/lib/api";

export type { Task, TaskBoard, TaskDetail, TaskColumn, TaskColumnTrigger };
export const taskKeys = {
  all: ["tasks"] as const,
  board: (projectId: string) => ["tasks", projectId, "board"] as const,
  detail: (id: string) => ["tasks", "detail", id] as const,
  assigned: (agentId: string) => ["tasks", "assigned", agentId] as const,
};
export function useTaskBoard(projectId: string | null, archived = false) {
  return useQuery<TaskBoard>({
    queryKey: archived
      ? [...taskKeys.board(projectId ?? ""), "archived"]
      : taskKeys.board(projectId ?? ""),
    queryFn: () =>
      api(
        `/api/v1/projects/${encodeURIComponent(projectId!)}/tasks/board${archived ? "?archived=1" : ""}`
      ),
    enabled: !!projectId,
  });
}
export function useTaskDetail(id: string | null) {
  return useQuery<TaskDetail>({
    queryKey: taskKeys.detail(id ?? ""),
    queryFn: () => api(`/api/v1/tasks/${encodeURIComponent(id!)}`),
    enabled: !!id,
  });
}
export function useAssignedTasks(agentId: string | null) {
  return useQuery<Task[]>({
    queryKey: taskKeys.assigned(agentId ?? ""),
    queryFn: () =>
      api(`/api/v1/tasks?assignedAgentId=${encodeURIComponent(agentId!)}`),
    enabled: !!agentId,
  });
}
export function useTaskActions(projectId: string | null) {
  const client = useQueryClient();
  const invalidate = async () => {
    await client.invalidateQueries({ queryKey: taskKeys.all });
  };
  const create = useMutation({
    mutationFn: (
      input: CreateTaskInput & {
        startupFiles?: File[];
        startupLinks?: string[];
      }
    ) => {
      const { startupFiles = [], startupLinks = [], ...fields } = input;
      let body: string | FormData = JSON.stringify(fields);
      if (startupFiles.length || startupLinks.length) {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields))
          if (value !== undefined) form.append(key, String(value));
        for (const file of startupFiles) form.append("startupFiles", file);
        form.append("startupLinks", JSON.stringify(startupLinks));
        body = form;
      }
      return api<Task>("/api/v1/tasks", { method: "POST", body });
    },
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ id, ...input }: UpdateTaskInput & { id: string }) =>
      api<Task>(`/api/v1/tasks/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onMutate: ({ id, ...input }) => {
      if (!projectId) return;
      const key = taskKeys.board(projectId);
      // Written synchronously: a dropped card has already left the drag
      // overlay, so a frame spent awaiting anything shows it back where
      // it was. In-flight refetches are cancelled so they cannot land
      // stale on top of this.
      void client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<TaskBoard>(key);
      client.setQueryData<TaskBoard>(key, (board) =>
        board
          ? {
              ...board,
              tasks: board.tasks.map((task) =>
                task.id === id
                  ? {
                      ...task,
                      ...input,
                      ...(input.columnId && input.columnId !== task.columnId
                        ? { latestFailure: null, launching: null }
                        : {}),
                    }
                  : task
              ),
            }
          : board
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (projectId && context?.previous)
        client.setQueryData(taskKeys.board(projectId), context.previous);
    },
    onSettled: invalidate,
  });
  const archive = useMutation({
    mutationFn: (id: string) =>
      api<Task>(`/api/v1/tasks/${encodeURIComponent(id)}/archive`, {
        method: "POST",
      }),
    onSuccess: invalidate,
  });
  const restore = useMutation({
    mutationFn: (id: string) =>
      api<Task>(`/api/v1/tasks/${encodeURIComponent(id)}/restore`, {
        method: "POST",
      }),
    onSuccess: invalidate,
  });
  const archiveColumn = useMutation({
    mutationFn: (id: string) =>
      api<{ archived: number }>(
        `/api/v1/projects/${encodeURIComponent(projectId!)}/task-columns/${encodeURIComponent(id)}/archive-tasks`,
        { method: "POST" }
      ),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/tasks/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
  const launch = useMutation({
    mutationFn: ({ id, ...input }: LaunchTaskAgentInput & { id: string }) =>
      api(`/api/v1/tasks/${encodeURIComponent(id)}/launch`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
  const createColumn = useMutation({
    mutationFn: (input: CreateTaskColumnInput) =>
      api<TaskColumn>(
        `/api/v1/projects/${encodeURIComponent(projectId!)}/task-columns`,
        { method: "POST", body: JSON.stringify(input) }
      ),
    onSuccess: invalidate,
  });
  const updateColumn = useMutation({
    mutationFn: ({ id, ...input }: UpdateTaskColumnInput & { id: string }) =>
      api<TaskColumn>(`/api/v1/task-columns/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
  const removeColumn = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/task-columns/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    onSuccess: invalidate,
  });
  const removeAgent = useMutation({
    mutationFn: ({ id, agentId }: { id: string; agentId: string }) =>
      api<TaskDetail>(
        `/api/v1/tasks/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentId)}`,
        { method: "DELETE" }
      ),
    onSuccess: invalidate,
  });
  return {
    archive,
    restore,
    archiveColumn,
    create,
    update,
    remove,
    launch,
    removeAgent,
    createColumn,
    updateColumn,
    removeColumn,
  };
}
