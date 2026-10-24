import { describe, expect, it } from "vitest";
import type { Task, TaskColumn } from "@/hooks/use-tasks";
import { groupTasks, nextPosition, visibleTasks } from "./task-utils";
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
  it("filters agent, attention, working, and recent done views", () => {
    expect(
      visibleTasks(tasks, columns, "agents", new Set(), new Set()).map(
        (task) => task.id
      )
    ).toEqual(["b"]);
    expect(
      visibleTasks(
        tasks,
        columns,
        "attention",
        new Set(["agent"]),
        new Set()
      ).map((task) => task.id)
    ).toEqual(["a"]);
    expect(
      visibleTasks(
        tasks,
        columns,
        "working",
        new Set(),
        new Set(["agent"])
      ).map((task) => task.id)
    ).toEqual(["a"]);
    expect(
      visibleTasks(tasks, columns, "done", new Set(), new Set()).map(
        (task) => task.id
      )
    ).toEqual(["c"]);
  });
});
