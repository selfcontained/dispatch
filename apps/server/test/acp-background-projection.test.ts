import { describe, expect, it } from "vitest";
import {
  emptyBackground,
  projectBackground,
  type BackgroundEvent,
} from "../src/agents/acp/background-projection.js";
const base = {
  type: "background" as const,
  agentId: "a",
  generation: "g1",
  sessionId: "s1",
  provider: "claude" as const,
  at: "2026-11-07T19:00:00.000Z",
  sequence: 1,
};
const capability: BackgroundEvent = {
  ...base,
  kind: "capability",
  supported: true,
};
const event = (
  sequence: number,
  update: Extract<BackgroundEvent, { kind: "update" }>["update"]
): BackgroundEvent => ({ ...base, kind: "update", sequence, update });
const spawn = {
  sessionUpdate: "async_task_spawned" as const,
  asyncTaskId: "t1",
  name: "watch",
  taskType: "monitor" as const,
  canStop: false,
  showInTranscript: false,
};
describe("bounded background lifecycle projection", () => {
  it("keeps unsupported, known empty, unknown and stale distinct", () => {
    expect(emptyBackground().capability).toBe("unknown");
    expect(projectBackground(emptyBackground(), capability)).toMatchObject({
      capability: "supported",
      items: [],
    });
    expect(
      projectBackground(emptyBackground(), { ...capability, supported: false })
    ).toMatchObject({ capability: "unsupported", items: [] });
  });
  it("never resurrects terminal-before-link and applies late metadata", () => {
    let state = projectBackground(emptyBackground(), capability);
    state = projectBackground(
      state,
      event(2, {
        sessionUpdate: "async_task_state_update",
        asyncTaskId: "t1",
        state: "completed",
      })
    );
    state = projectBackground(state, event(3, spawn));
    state = projectBackground(
      state,
      event(4, {
        sessionUpdate: "async_task_progress",
        asyncTaskId: "t1",
        toolCallId: "tool-1",
        summary: "done",
      })
    );
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      state: "completed",
      taskType: "monitor",
      toolCallId: "tool-1",
      summary: "done",
    });
    expect(projectBackground(state, event(2, spawn))).toEqual(state);
    expect(projectBackground(state, event(4, spawn))).toEqual(state);
  });
  it("preserves pause and explicit terminal corrections", () => {
    let state = projectBackground(emptyBackground(), capability);
    for (const [sequence, status] of [
      [2, "paused"],
      [3, "stopped"],
      [4, "completed"],
      [5, "running"],
    ] as const) {
      state = projectBackground(
        state,
        event(sequence, {
          sessionUpdate: "async_task_state_update",
          asyncTaskId: "t1",
          state: status,
        })
      );
    }
    expect(state.items[0]?.state).toBe("completed");
  });
  it("does not revive old generations on journal replay or replacement", () => {
    let state = projectBackground(
      projectBackground(emptyBackground(), capability),
      event(2, spawn)
    );
    state = projectBackground(state, {
      ...capability,
      generation: "g2",
      at: "2026-11-07T19:01:00.000Z",
    });
    expect(state.items[0]?.stale).toBe(true);
    expect(projectBackground(state, capability)).toEqual(state);
    expect(projectBackground(state, event(3, spawn))).toEqual(state);
    state = projectBackground(state, { ...event(2, spawn), generation: "g2" });
    expect(state.items).toHaveLength(2);
  });
  it("bounds active and completed history", () => {
    let state = projectBackground(emptyBackground(), capability);
    for (let i = 0; i < 250; i++)
      state = projectBackground(
        state,
        event(i + 2, { ...spawn, asyncTaskId: `t${i}` })
      );
    expect(state.items).toHaveLength(200);
    expect(state.truncated).toBe(true);
    expect(projectBackground(state, event(2, spawn))).toEqual(state);
  });
});

describe("terminal identity retention under pressure", () => {
  it("suppresses newly arriving late spawn and progress after display pruning", () => {
    let state = projectBackground(emptyBackground(), capability);
    state = projectBackground(
      state,
      event(2, {
        sessionUpdate: "async_task_state_update",
        asyncTaskId: "finished",
        state: "completed",
      })
    );
    for (let i = 0; i < 200; i++)
      state = projectBackground(
        state,
        event(i + 3, { ...spawn, asyncTaskId: `other-${i}` })
      );
    expect(state.items.find((item) => item.id === "finished")).toBeUndefined();
    state = projectBackground(
      state,
      event(204, { ...spawn, asyncTaskId: "finished" })
    );
    expect(
      state.items.find(
        (item) => item.id === "finished" && item.state === "running"
      )
    ).toBeUndefined();
    state = projectBackground(
      state,
      event(205, {
        sessionUpdate: "async_task_progress",
        asyncTaskId: "finished",
        toolCallId: "late-tool",
      })
    );
    expect(
      state.items.find(
        (item) => item.id === "finished" && item.state === "running"
      )
    ).toBeUndefined();
    expect(state.terminalIdentities).toContainEqual({
      id: "finished",
      state: "completed",
    });
  });
  it("fails closed for new identities after the independent identity bound", () => {
    let state = projectBackground(emptyBackground(), capability);
    for (let i = 0; i < 1001; i++)
      state = projectBackground(
        state,
        event(i + 2, {
          sessionUpdate: "async_task_state_update",
          asyncTaskId: `terminal-${i}`,
          state: "completed",
        })
      );
    expect(state.terminalIdentities).toHaveLength(1000);
    expect(state.identityOverflow).toBe(true);
    state = projectBackground(
      state,
      event(1004, { ...spawn, asyncTaskId: "terminal-1000" })
    );
    expect(state.items.some((item) => item.id === "terminal-1000")).toBe(false);
    state = projectBackground(
      state,
      event(1005, { ...spawn, asyncTaskId: "unknown-new" })
    );
    expect(state.items.some((item) => item.id === "unknown-new")).toBe(false);
  });
});
