import { describe, expect, it } from "vitest";

import { StartupStateStore } from "../src/server/startup-state.js";

describe("StartupStateStore", () => {
  it("tracks database outages and clears them when initialization recovers", () => {
    const state = new StartupStateStore();

    expect(state.snapshot()).toEqual({ state: "initializing", error: null });

    state.setDatabaseUnavailable("password authentication failed");
    expect(state.snapshot()).toEqual({
      state: "database_unavailable",
      error: "password authentication failed",
    });

    state.setReady();
    expect(state.snapshot()).toEqual({ state: "ready", error: null });
  });
});
