import { describe, expect, it } from "vitest";
import type { Task, TaskColumn } from "@/hooks/use-tasks";
import type { Agent } from "@/components/app/types";
import {
  agentQualifier,
  taskMentionables,
  columnAccent,
  groupTasks,
  needsAttention,
  nextPosition,
  visibleTasks,
} from "./task-utils";
const columns = [
  {
    id: "backlog",
    position: 0,
    isDone: false,
    key: "backlog",
    name: "Backlog",
  },
  { id: "done", position: 1, isDone: true, key: "done", name: "Done" },
] as TaskColumn[];
const tasks = [
  {
    id: "b",
    columnId: "backlog",
    position: 20,
    createdBy: { kind: "agent", agentId: "agent" },
    createdAt: new Date().toISOString(),
    assignedAgentId: null,
  },
  {
    id: "a",
    columnId: "backlog",
    position: 10,
    createdBy: { kind: "user" },
    createdAt: new Date().toISOString(),
    assignedAgentId: "agent",
  },
  {
    id: "c",
    columnId: "done",
    position: 1,
    completedAt: new Date().toISOString(),
    createdBy: { kind: "user" },
    createdAt: new Date().toISOString(),
    assignedAgentId: null,
  },
] as Task[];
describe("task board utilities", () => {
  it("groups by ordered column and manual position", () => {
    expect(
      groupTasks(tasks, columns).map((group) =>
        group.tasks.map((task) => task.id)
      )
    ).toEqual([["a", "b"], ["c"]]);
  });
  it("computes a stable insertion position without changing other tasks", () => {
    expect(nextPosition(tasks, "backlog", "b")).toBeLessThan(20);
    expect(nextPosition(tasks, "backlog", "a")).toBeLessThan(10);
    expect(nextPosition(tasks, "done")).toBe(2);
  });
  it("hides done work older than a week and flags attention", () => {
    const old = {
      ...tasks[2],
      id: "old",
      completedAt: new Date(Date.now() - 8 * 86400000).toISOString(),
    } as Task;
    expect(
      visibleTasks([...tasks, old], columns).map((task) => task.id)
    ).toEqual(["b", "a", "c"]);
    expect(
      tasks
        .filter((task) => needsAttention(task, new Set(["agent"])))
        .map((task) => task.id)
    ).toEqual(["a"]);
  });
  it("gives known columns a fixed accent and cycles the rest", () => {
    expect(columnAccent(columns[1], 1)).toBe("var(--chart-1)");
    expect(
      columnAccent({ ...columns[0], key: "custom" } as TaskColumn, 0)
    ).toBe("var(--chart-3)");
  });
  it("names the task's agents, then running roots, never a non-member child", () => {
    const agent = (id: string, extra: Partial<Agent> = {}) =>
      ({ id, name: id, status: "running", ...extra }) as Agent;
    const offered = taskMentionables(
      ["assignee", "member-elsewhere"],
      [
        agent("assignee"),
        agent("assignee-child", { parentAgentId: "assignee" }),
        agent("member-elsewhere", { parentAgentId: "other-root" }),
        agent("assignee two"),
        agent("stopped-root", { status: "stopped" }),
      ]
    );
    expect(offered.map((item) => item.id)).toEqual([
      "assignee",
      "member-elsewhere",
      "assignee two",
    ]);
    // An outside name that reads as a member's is qualified by id, as the
    // server resolves it.
    expect(offered[2].mentionName).toBe("assignee two [assignee two]");
  });
});

describe("agentQualifier", () => {
  const at = (minutesAgo: number) =>
    new Date(Date.now() - minutesAgo * 60000).toISOString();
  const builder = (id: string, createdAt: string) =>
    ({ id, name: "Builder", createdAt }) as Agent;
  it("is nothing while the name is unique", () => {
    const one = builder("agt_1", at(5));
    expect(
      agentQualifier(one, [one, { id: "agt_2", name: "Reviewer" } as Agent])
    ).toBeNull();
  });
  it("says when each same-named agent started, to the minute under an hour", () => {
    const fresh = builder("agt_1", at(0));
    const earlier = builder("agt_2", at(7));
    const old = builder("agt_3", at(3 * 60));
    const all = [fresh, earlier, old];
    expect(agentQualifier(fresh, all)).toBe("now");
    expect(agentQualifier(earlier, all)).toBe("7m");
    expect(agentQualifier(old, all)).toBe("3h");
  });
});
