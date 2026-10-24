import type { Task, TaskBoard, TaskColumn } from "@/hooks/use-tasks";
import { qualifyExternalMentions } from "@dispatch/shared";
import type { Agent } from "@/components/app/types";
import type { Mentionable } from "@/lib/mentions";
export function orderedColumns(board: TaskBoard): TaskColumn[] {
  return [...board.columns].sort((a, b) => a.position - b.position);
}
export function tasksInColumn(tasks: Task[], columnId: string): Task[] {
  return tasks
    .filter((task) => task.columnId === columnId)
    .sort((a, b) => a.position - b.position);
}
export function nextPosition(
  tasks: Task[],
  columnId: string,
  beforeId?: string
): number {
  const ordered = tasksInColumn(tasks, columnId);
  if (!ordered.length) return 0;
  if (!beforeId) return ordered[ordered.length - 1].position + 1;
  const index = ordered.findIndex((task) => task.id === beforeId);
  if (index < 0) return ordered[ordered.length - 1].position + 1;
  return index === 0
    ? ordered[0].position - 1
    : (ordered[index - 1].position + ordered[index].position) / 2;
}
/** The board's default scope: everything except work finished over a week ago. */
export function visibleTasks(tasks: Task[], columns: TaskColumn[]): Task[] {
  const doneIds = new Set(
    columns.filter((column) => column.isDone).map((column) => column.id)
  );
  const weekAgo = Date.now() - 7 * 86400000;
  return tasks.filter(
    (task) =>
      !doneIds.has(task.columnId) ||
      !task.completedAt ||
      Date.parse(task.completedAt) > weekAgo
  );
}
/** A failed launch, or an assignee blocked or waiting on someone. */
export function needsAttention(task: Task, attentionIds: Set<string>): boolean {
  return (
    !!task.latestFailure ||
    (!!task.assignedAgentId && attentionIds.has(task.assignedAgentId))
  );
}
/** Accent token per column: known keys keep their colour, others cycle. */
const COLUMN_ACCENTS: Record<string, string> = {
  // Not started yet: a neutral, so the coloured columns read as progress.
  backlog: "--muted-foreground",
  ready: "--chart-3",
  in_progress: "--chart-2",
  in_review: "--chart-4",
  done: "--chart-1",
};
const ACCENT_CYCLE = [
  "--chart-3",
  "--chart-2",
  "--chart-4",
  "--chart-1",
  "--chart-5",
  "--chart-6",
];
export function columnAccent(column: TaskColumn, index: number): string {
  const token =
    COLUMN_ACCENTS[column.key] ?? ACCENT_CYCLE[index % ACCENT_CYCLE.length];
  return `var(${token})`;
}
export function groupTasks(
  tasks: Task[],
  columns: TaskColumn[]
): Array<{ column: TaskColumn; tasks: Task[] }> {
  return orderedColumns({ columns, tasks, projectId: "" }).map((column) => ({
    column,
    tasks: tasksInColumn(tasks, column.id),
  }));
}
export function taskAge(date: string): string {
  const days = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(date)) / 86400000)
  );
  if (days) return `${days}d`;
  const hours = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(date)) / 3600000)
  );
  return hours ? `${hours}h` : "now";
}
/**
 * What tells this agent apart when another in the list wears the same
 * name (two "Builder"s launched by the same column): when it started.
 * Null when the name is enough.
 */
export function agentQualifier(
  agent: Agent,
  agents: readonly Agent[] | undefined
): string | null {
  const name = agent.name.trim().toLowerCase();
  const clash = agents?.some(
    (other) => other.id !== agent.id && other.name.trim().toLowerCase() === name
  );
  if (!clash || !agent.createdAt) return null;
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(agent.createdAt)) / 60000)
  );
  if (minutes < 1) return "started just now";
  if (minutes < 60) return `started ${minutes}m ago`;
  return `started ${taskAge(agent.createdAt)} ago`;
}
/**
 * How an agent came to be on a task, in words: a column's automation
 * launched it, a person assigned it, or it claimed the task itself.
 */
export function assignmentLabel(
  assignment: { role: "trigger" | "manual" | "self"; columnId: string | null },
  columns: readonly TaskColumn[]
): string {
  if (assignment.role === "trigger") {
    const column = columns.find((c) => c.id === assignment.columnId);
    return column ? `launched by ${column.name}` : "launched by an automation";
  }
  return assignment.role === "self" ? "picked it up" : "assigned by you";
}
/** A column trigger's template, by name; the id when it is gone. */
export function templateName(
  templates: ReadonlyArray<{ id: string; name: string }> | undefined,
  templateId: string
): string {
  return templates?.find((t) => t.id === templateId)?.name ?? templateId;
}
/** Running agents first, then the rest; each group by name. */
export function assigneeOptions(
  agents: Agent[],
  projectId: string,
  currentId: string | null
): Agent[] {
  const live = (agent: Agent) =>
    agent.status === "running" || agent.status === "creating" ? 0 : 1;
  return agents
    .filter((agent) => agent.projectId === projectId || agent.id === currentId)
    .sort((a, b) => live(a) - live(b) || a.name.localeCompare(b.name));
}
/**
 * Who a post in a task's conversation can name, as the server resolves it:
 * the task's agents, then running top-level agents from elsewhere, those
 * qualified by id where their name could be read as a member's.
 */
export function taskMentionables(
  memberIds: readonly string[],
  agents: readonly Agent[]
): Mentionable[] {
  const members = new Set(memberIds);
  const byAge = (a: Agent, b: Agent) =>
    (a.createdAt ?? "").localeCompare(b.createdAt ?? "") ||
    a.id.localeCompare(b.id);
  const toMentionable = (agent: Agent): Mentionable => ({
    id: agent.id,
    name: agent.name,
    agentType: agent.type ?? null,
  });
  const tree = agents
    .filter((agent) => members.has(agent.id))
    .sort(byAge)
    .map(toMentionable);
  const external = agents
    .filter(
      (agent) =>
        !members.has(agent.id) &&
        !agent.parentAgentId &&
        agent.status === "running"
    )
    .sort(byAge)
    .map(toMentionable);
  return [...tree, ...qualifyExternalMentions(tree, external)];
}
/** History state marking an entry pushed by opening the task modal. */
export const TASK_MODAL_STATE = { taskModal: true } as const;
/** The app's menu items default to the destructive tint; these are ordinary. */
export const MENU_ITEM =
  "text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50";
