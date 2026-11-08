import { expect, it } from "vitest";
import { BackgroundWorkRegistry } from "../src/agents/acp/background-work.js";
const spawn = {
  sessionUpdate: "async_task_spawned" as const,
  asyncTaskId: "a",
  name: "Watch build",
  taskType: "shell",
  canStop: true,
  showInTranscript: false,
};
it("keeps only live command/monitor names and states, then drops terminal work", () => {
  const work = new BackgroundWorkRegistry();
  work.setSupported(true);
  work.apply(spawn);
  work.apply({
    sessionUpdate: "async_task_state_update",
    asyncTaskId: "a",
    state: "paused",
  });
  expect(work.snapshot()).toEqual({
    status: "supported",
    items: [{ id: "a", name: "Watch build", kind: "shell", state: "paused" }],
  });
  work.apply({
    sessionUpdate: "async_task_state_update",
    asyncTaskId: "a",
    state: "completed",
  });
  work.apply(spawn);
  expect(work.snapshot()).toEqual({ status: "supported", items: [] });
});
it("does not revive terminal-before-start and does not inventory autonomous turns", () => {
  const work = new BackgroundWorkRegistry();
  work.setSupported(true);
  work.apply({
    sessionUpdate: "async_task_state_update",
    asyncTaskId: "a",
    state: "failed",
  });
  work.apply(spawn);
  work.apply({ ...spawn, asyncTaskId: "turn", taskType: "turn" });
  expect(work.snapshot().items).toEqual([]);
  const replacement = new BackgroundWorkRegistry();
  replacement.setSupported(true);
  expect(replacement.snapshot().items).toEqual([]);
});
it("reports unavailable on capacity loss rather than inventing a partial current list", () => {
  const work = new BackgroundWorkRegistry();
  work.setSupported(true);
  for (let i = 0; i < 201; i++)
    work.apply({ ...spawn, asyncTaskId: String(i) });
  expect(work.snapshot()).toEqual({ status: "unavailable", items: [] });
});
