import { describe, expect, it, vi } from "vitest";
import { TaskService, type TaskServiceDeps } from "../src/tasks/service.js";

// No database: catch generation-agnostic cancellation at the service boundary.
// The separate DB regression interleaves actual delete/resubscribe/debounce.
describe("unsubscribe delivery ownership", () => {
  it.each(["board", "task"] as const)(
    "%s unsubscribe cannot cancel a later generation's queued delivery",
    async (scope) => {
      const cancel = vi.fn();
      const query = vi.fn(async (sql: string) => ({
        rows: sql.includes("FROM agents")
          ? [{ id: "caller" }]
          : sql.includes("SELECT DISTINCT i.task_id")
            ? [{ task_id: "task" }]
            : [],
      }));
      const service = new TaskService({
        pool: { query },
        getAgent: async () => ({ id: "caller", projectId: "project" }),
        watches: { schedule: vi.fn(), cancel },
      } as unknown as TaskServiceDeps);
      // Also models the earlier task-unwatch implementation's pre-delete scope
      // read: no board watch existed at that read, but fresh coverage can start
      // before a generation-agnostic cancellation resumes.
      vi.spyOn(service, "requireTask").mockResolvedValue({
        id: "task",
        projectId: "project",
      } as never);
      if (scope === "board") await service.unwatchBoard("project", "caller");
      else await service.unwatch("task", "caller");
      expect(query).toHaveBeenCalledWith(
        `DELETE FROM ${scope === "board" ? "task_board_watches" : "task_watches"} WHERE ${scope === "board" ? "project_id" : "task_id"} = $1 AND agent_id = $2`,
        [scope === "board" ? "project" : "task", "caller"]
      );
      // Deletion invalidates original inbox coverage. Only acceptance knows which
      // queued generation it owns; service cancellation has no such identity.
      expect(cancel).not.toHaveBeenCalled();
    }
  );
});
