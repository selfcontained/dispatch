// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  reconcileAgentSidebarOrder,
  reconcileMediaSidebarStateStorage,
  MEDIA_SIDEBAR_STATE_STORAGE_PREFIX,
  defaultMediaSidebarState,
  reconcileDiffViewStateStorage,
  DIFF_VIEW_STATE_STORAGE_PREFIX,
  reconcileSplitPaneStateStorage,
  SPLIT_PANE_STATE_STORAGE_PREFIX,
} from "./store";

describe("reconcileAgentSidebarOrder", () => {
  it("puts new agents first and keeps stored order for live agents", () => {
    expect(
      reconcileAgentSidebarOrder(
        ["agt_2", "agt_1"],
        ["agt_1", "agt_2", "agt_3"]
      )
    ).toEqual(["agt_3", "agt_2", "agt_1"]);
  });

  it("drops archived and duplicate agent ids", () => {
    expect(
      reconcileAgentSidebarOrder(
        ["agt_2", "agt_old", "agt_2", "agt_1"],
        ["agt_1", "agt_2"]
      )
    ).toEqual(["agt_2", "agt_1"]);
  });
});

describe("reconcileMediaSidebarStateStorage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  const storeForAgent = (agentId: string) => {
    window.localStorage.setItem(
      `${MEDIA_SIDEBAR_STATE_STORAGE_PREFIX}${agentId}`,
      JSON.stringify(defaultMediaSidebarState)
    );
  };

  it("removes keys for agents not in the live set", () => {
    storeForAgent("agt_1");
    storeForAgent("agt_2");
    storeForAgent("agt_3");

    reconcileMediaSidebarStateStorage(["agt_1", "agt_3"]);

    expect(
      window.localStorage.getItem(`${MEDIA_SIDEBAR_STATE_STORAGE_PREFIX}agt_1`)
    ).not.toBeNull();
    expect(
      window.localStorage.getItem(`${MEDIA_SIDEBAR_STATE_STORAGE_PREFIX}agt_2`)
    ).toBeNull();
    expect(
      window.localStorage.getItem(`${MEDIA_SIDEBAR_STATE_STORAGE_PREFIX}agt_3`)
    ).not.toBeNull();
  });

  it("does nothing when all stored agents are live", () => {
    storeForAgent("agt_1");
    storeForAgent("agt_2");

    reconcileMediaSidebarStateStorage(["agt_1", "agt_2"]);

    expect(window.localStorage.length).toBe(2);
  });

  it("removes all media sidebar keys when live set is empty", () => {
    storeForAgent("agt_1");
    storeForAgent("agt_2");

    reconcileMediaSidebarStateStorage([]);

    expect(window.localStorage.length).toBe(0);
  });

  it("does nothing when localStorage is empty", () => {
    reconcileMediaSidebarStateStorage(["agt_1"]);

    expect(window.localStorage.length).toBe(0);
  });

  it("does not affect non-media-sidebar keys", () => {
    window.localStorage.setItem("dispatch:leftSidebarOpen", "true");
    window.localStorage.setItem("unrelated-key", "value");
    storeForAgent("agt_dead");

    reconcileMediaSidebarStateStorage([]);

    expect(window.localStorage.getItem("dispatch:leftSidebarOpen")).toBe(
      "true"
    );
    expect(window.localStorage.getItem("unrelated-key")).toBe("value");
    expect(
      window.localStorage.getItem(
        `${MEDIA_SIDEBAR_STATE_STORAGE_PREFIX}agt_dead`
      )
    ).toBeNull();
  });

  it("accepts a Set as agentIds", () => {
    storeForAgent("agt_1");
    storeForAgent("agt_2");

    reconcileMediaSidebarStateStorage(new Set(["agt_1"]));

    expect(
      window.localStorage.getItem(`${MEDIA_SIDEBAR_STATE_STORAGE_PREFIX}agt_1`)
    ).not.toBeNull();
    expect(
      window.localStorage.getItem(`${MEDIA_SIDEBAR_STATE_STORAGE_PREFIX}agt_2`)
    ).toBeNull();
  });
});

describe("reconcileDiffViewStateStorage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  const defaultDiffState = JSON.stringify({
    collapsedFiles: [],
    collapsedDirs: [],
    scrollTop: 0,
  });

  const storeDiffForAgent = (agentId: string) => {
    window.localStorage.setItem(
      `${DIFF_VIEW_STATE_STORAGE_PREFIX}${agentId}`,
      defaultDiffState
    );
  };

  it("removes keys for agents not in the live set", () => {
    storeDiffForAgent("agt_1");
    storeDiffForAgent("agt_2");
    storeDiffForAgent("agt_3");

    reconcileDiffViewStateStorage(["agt_1", "agt_3"]);

    expect(
      window.localStorage.getItem(`${DIFF_VIEW_STATE_STORAGE_PREFIX}agt_1`)
    ).not.toBeNull();
    expect(
      window.localStorage.getItem(`${DIFF_VIEW_STATE_STORAGE_PREFIX}agt_2`)
    ).toBeNull();
    expect(
      window.localStorage.getItem(`${DIFF_VIEW_STATE_STORAGE_PREFIX}agt_3`)
    ).not.toBeNull();
  });

  it("does nothing when all stored agents are live", () => {
    storeDiffForAgent("agt_1");
    storeDiffForAgent("agt_2");

    reconcileDiffViewStateStorage(["agt_1", "agt_2"]);

    expect(window.localStorage.length).toBe(2);
  });

  it("removes all diff view keys when live set is empty", () => {
    storeDiffForAgent("agt_1");
    storeDiffForAgent("agt_2");

    reconcileDiffViewStateStorage([]);

    expect(window.localStorage.length).toBe(0);
  });

  it("does nothing when localStorage is empty", () => {
    reconcileDiffViewStateStorage(["agt_1"]);

    expect(window.localStorage.length).toBe(0);
  });

  it("does not affect non-diff-view keys", () => {
    window.localStorage.setItem("dispatch:leftSidebarOpen", "true");
    window.localStorage.setItem(
      `${MEDIA_SIDEBAR_STATE_STORAGE_PREFIX}agt_live`,
      "{}"
    );
    storeDiffForAgent("agt_dead");

    reconcileDiffViewStateStorage([]);

    expect(window.localStorage.getItem("dispatch:leftSidebarOpen")).toBe(
      "true"
    );
    expect(
      window.localStorage.getItem(
        `${MEDIA_SIDEBAR_STATE_STORAGE_PREFIX}agt_live`
      )
    ).toBe("{}");
    expect(
      window.localStorage.getItem(`${DIFF_VIEW_STATE_STORAGE_PREFIX}agt_dead`)
    ).toBeNull();
  });

  it("accepts a Set as agentIds", () => {
    storeDiffForAgent("agt_1");
    storeDiffForAgent("agt_2");

    reconcileDiffViewStateStorage(new Set(["agt_1"]));

    expect(
      window.localStorage.getItem(`${DIFF_VIEW_STATE_STORAGE_PREFIX}agt_1`)
    ).not.toBeNull();
    expect(
      window.localStorage.getItem(`${DIFF_VIEW_STATE_STORAGE_PREFIX}agt_2`)
    ).toBeNull();
  });
});

describe("reconcileSplitPaneStateStorage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  const defaultSplitState = JSON.stringify({
    mode: "single",
    left: "terminal",
    right: "changes",
    sizes: [50, 50],
  });

  const storeForAgent = (agentId: string) => {
    window.localStorage.setItem(
      `${SPLIT_PANE_STATE_STORAGE_PREFIX}${agentId}`,
      defaultSplitState
    );
  };

  it("removes keys for agents not in the live set", () => {
    storeForAgent("agt_1");
    storeForAgent("agt_2");
    storeForAgent("agt_3");

    reconcileSplitPaneStateStorage(["agt_1", "agt_3"]);

    expect(
      window.localStorage.getItem(`${SPLIT_PANE_STATE_STORAGE_PREFIX}agt_1`)
    ).not.toBeNull();
    expect(
      window.localStorage.getItem(`${SPLIT_PANE_STATE_STORAGE_PREFIX}agt_2`)
    ).toBeNull();
    expect(
      window.localStorage.getItem(`${SPLIT_PANE_STATE_STORAGE_PREFIX}agt_3`)
    ).not.toBeNull();
  });

  it("does nothing when all stored agents are live", () => {
    storeForAgent("agt_1");
    storeForAgent("agt_2");

    reconcileSplitPaneStateStorage(["agt_1", "agt_2"]);

    expect(window.localStorage.length).toBe(2);
  });

  it("removes all split pane keys when live set is empty", () => {
    storeForAgent("agt_1");
    storeForAgent("agt_2");

    reconcileSplitPaneStateStorage([]);

    expect(window.localStorage.length).toBe(0);
  });

  it("handles empty live set gracefully", () => {
    storeForAgent("agt_1");
    reconcileSplitPaneStateStorage([]);
    expect(
      window.localStorage.getItem(`${SPLIT_PANE_STATE_STORAGE_PREFIX}agt_1`)
    ).toBeNull();
  });

  it("does nothing when localStorage is empty", () => {
    reconcileSplitPaneStateStorage(["agt_1"]);

    expect(window.localStorage.length).toBe(0);
  });

  it("does not affect non-split-pane keys", () => {
    window.localStorage.setItem("dispatch:leftSidebarOpen", "true");
    window.localStorage.setItem(
      `${MEDIA_SIDEBAR_STATE_STORAGE_PREFIX}agt_live`,
      "{}"
    );
    storeForAgent("agt_dead");

    reconcileSplitPaneStateStorage([]);

    expect(window.localStorage.getItem("dispatch:leftSidebarOpen")).toBe(
      "true"
    );
    expect(
      window.localStorage.getItem(
        `${MEDIA_SIDEBAR_STATE_STORAGE_PREFIX}agt_live`
      )
    ).toBe("{}");
    expect(
      window.localStorage.getItem(`${SPLIT_PANE_STATE_STORAGE_PREFIX}agt_dead`)
    ).toBeNull();
  });

  it("accepts a Set as agentIds", () => {
    storeForAgent("agt_1");
    storeForAgent("agt_2");

    reconcileSplitPaneStateStorage(new Set(["agt_1"]));

    expect(
      window.localStorage.getItem(`${SPLIT_PANE_STATE_STORAGE_PREFIX}agt_1`)
    ).not.toBeNull();
    expect(
      window.localStorage.getItem(`${SPLIT_PANE_STATE_STORAGE_PREFIX}agt_2`)
    ).toBeNull();
  });
});
