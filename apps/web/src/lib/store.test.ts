// @vitest-environment jsdom
import * as jotai from "jotai";
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
  LEGACY_SPLIT_PANE_STATE_STORAGE_PREFIX,
  splitPaneStateAtomFamily,
  defaultSplitPaneState,
  type SplitPaneState,
  atomWithLocalStorage,
  isPersistedSplitPaneState,
  reconcileSeenSurfaceIdsStorage,
  SEEN_SURFACE_IDS_STORAGE_PREFIX,
  isSystemSidebarTab,
  reconcileAgentScopedStorage,
  CUSTOM_TAB_ORDER_STORAGE_PREFIX,
  SURFACE_FORM_DRAFT_STORAGE_PREFIX,
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

describe("sidebar tab and scoped storage helpers", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it("keeps system tabs explicit while permitting dynamic surface ids", () => {
    expect(isSystemSidebarTab("pins")).toBe(true);
    expect(isSystemSidebarTab("surface-a")).toBe(false);
    expect(isSystemSidebarTab("review")).toBe(false);
  });

  it("reconciles all per-agent storage in one pass with safe draft extraction", () => {
    window.localStorage.setItem(
      `${MEDIA_SIDEBAR_STATE_STORAGE_PREFIX}agt_live`,
      "{}"
    );
    window.localStorage.setItem(
      `${CUSTOM_TAB_ORDER_STORAGE_PREFIX}agt_dead`,
      "[]"
    );
    window.localStorage.setItem(
      `${SURFACE_FORM_DRAFT_STORAGE_PREFIX}agt_live:surface:block`,
      "{}"
    );
    window.localStorage.setItem(
      `${SURFACE_FORM_DRAFT_STORAGE_PREFIX}agt_dead:surface:block`,
      "{}"
    );
    window.localStorage.setItem("dispatch:unrelated", "keep");

    reconcileAgentScopedStorage(["agt_live"]);

    expect(window.localStorage.getItem("dispatch:unrelated")).toBe("keep");
    expect(
      window.localStorage.getItem(`${CUSTOM_TAB_ORDER_STORAGE_PREFIX}agt_dead`)
    ).toBeNull();
    expect(
      window.localStorage.getItem(
        `${SURFACE_FORM_DRAFT_STORAGE_PREFIX}agt_live:surface:block`
      )
    ).not.toBeNull();
    expect(
      window.localStorage.getItem(
        `${SURFACE_FORM_DRAFT_STORAGE_PREFIX}agt_dead:surface:block`
      )
    ).toBeNull();
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

  it("uses the versioned key so a rolled-back client never reads a chat pane", () => {
    expect(SPLIT_PANE_STATE_STORAGE_PREFIX).toBe("dispatch:splitPaneV2:");
    expect(LEGACY_SPLIT_PANE_STATE_STORAGE_PREFIX).toBe("dispatch:splitPane:");
  });

  it("also drops legacy-key entries for agents not in the live set", () => {
    storeForAgent("agt_1");
    window.localStorage.setItem(
      `${LEGACY_SPLIT_PANE_STATE_STORAGE_PREFIX}agt_1`,
      defaultSplitState
    );
    window.localStorage.setItem(
      `${LEGACY_SPLIT_PANE_STATE_STORAGE_PREFIX}agt_gone`,
      defaultSplitState
    );

    reconcileSplitPaneStateStorage(["agt_1"]);

    expect(
      window.localStorage.getItem(`${SPLIT_PANE_STATE_STORAGE_PREFIX}agt_1`)
    ).not.toBeNull();
    expect(
      window.localStorage.getItem(
        `${LEGACY_SPLIT_PANE_STATE_STORAGE_PREFIX}agt_1`
      )
    ).not.toBeNull();
    expect(
      window.localStorage.getItem(
        `${LEGACY_SPLIT_PANE_STATE_STORAGE_PREFIX}agt_gone`
      )
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

describe("reconcileSeenSurfaceIdsStorage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  const storeForAgent = (agentId: string) => {
    window.localStorage.setItem(
      `${SEEN_SURFACE_IDS_STORAGE_PREFIX}${agentId}`,
      JSON.stringify(["surface-a"])
    );
  };

  it("removes keys for agents not in the live set", () => {
    storeForAgent("agt_1");
    storeForAgent("agt_2");

    reconcileSeenSurfaceIdsStorage(["agt_1"]);

    expect(
      window.localStorage.getItem(`${SEEN_SURFACE_IDS_STORAGE_PREFIX}agt_1`)
    ).not.toBeNull();
    expect(
      window.localStorage.getItem(`${SEEN_SURFACE_IDS_STORAGE_PREFIX}agt_2`)
    ).toBeNull();
  });

  it("leaves unrelated keys untouched", () => {
    window.localStorage.setItem("dispatch:leftSidebarOpen", "true");
    storeForAgent("agt_dead");

    reconcileSeenSurfaceIdsStorage([]);

    expect(window.localStorage.getItem("dispatch:leftSidebarOpen")).toBe(
      "true"
    );
    expect(
      window.localStorage.getItem(`${SEEN_SURFACE_IDS_STORAGE_PREFIX}agt_dead`)
    ).toBeNull();
  });
});

describe("splitPaneStateAtomFamily storage migration", () => {
  const { createStore } = jotai;

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  const split: SplitPaneState = {
    mode: "split",
    left: "agent",
    right: "changes",
    sizes: [40, 60],
  };

  it("falls back to the legacy key when the v2 key is absent", () => {
    window.localStorage.setItem(
      `${LEGACY_SPLIT_PANE_STATE_STORAGE_PREFIX}agt_legacy_read`,
      JSON.stringify(split)
    );
    const store = createStore();
    expect(store.get(splitPaneStateAtomFamily("agt_legacy_read"))).toEqual(
      split
    );
  });

  it("prefers the v2 key when both are present", () => {
    window.localStorage.setItem(
      `${LEGACY_SPLIT_PANE_STATE_STORAGE_PREFIX}agt_both`,
      JSON.stringify(split)
    );
    window.localStorage.setItem(
      `${SPLIT_PANE_STATE_STORAGE_PREFIX}agt_both`,
      JSON.stringify(defaultSplitPaneState)
    );
    const store = createStore();
    expect(store.get(splitPaneStateAtomFamily("agt_both"))).toEqual(
      defaultSplitPaneState
    );
  });

  it("reads an off-shape stored value as the default", () => {
    window.localStorage.setItem(
      `${SPLIT_PANE_STATE_STORAGE_PREFIX}agt_corrupt`,
      JSON.stringify({ mode: "split", left: "nope", right: "changes" })
    );
    const store = createStore();
    expect(store.get(splitPaneStateAtomFamily("agt_corrupt"))).toEqual(
      defaultSplitPaneState
    );
  });

  it("writes only the v2 key and leaves the legacy value untouched", () => {
    const legacy = JSON.stringify({
      mode: "split",
      left: "terminal",
      right: "changes",
      sizes: [50, 50],
    });
    window.localStorage.setItem(
      `${LEGACY_SPLIT_PANE_STATE_STORAGE_PREFIX}agt_legacy_write`,
      legacy
    );
    const store = createStore();
    const atom = splitPaneStateAtomFamily("agt_legacy_write");
    store.set(atom, split);

    expect(
      window.localStorage.getItem(
        `${SPLIT_PANE_STATE_STORAGE_PREFIX}agt_legacy_write`
      )
    ).toBe(JSON.stringify(split));
    // A client rolled back to the v1 schema still sees only what it wrote.
    expect(
      window.localStorage.getItem(
        `${LEGACY_SPLIT_PANE_STATE_STORAGE_PREFIX}agt_legacy_write`
      )
    ).toBe(legacy);
  });
});

describe("isPersistedSplitPaneState", () => {
  it("accepts current and round-1/2 tab ids on either side", () => {
    expect(
      isPersistedSplitPaneState({
        mode: "split",
        left: "chat",
        right: "terminal",
        sizes: [30, 70],
      })
    ).toBe(true);
    expect(isPersistedSplitPaneState(defaultSplitPaneState)).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isPersistedSplitPaneState(null)).toBe(false);
    expect(isPersistedSplitPaneState("split")).toBe(false);
    expect(
      isPersistedSplitPaneState({ ...defaultSplitPaneState, mode: "wide" })
    ).toBe(false);
    expect(
      isPersistedSplitPaneState({ ...defaultSplitPaneState, left: "files" })
    ).toBe(false);
    expect(
      isPersistedSplitPaneState({ ...defaultSplitPaneState, sizes: [50] })
    ).toBe(false);
    expect(
      isPersistedSplitPaneState({ ...defaultSplitPaneState, sizes: ["a", 1] })
    ).toBe(false);
  });
});

describe("atomWithLocalStorage", () => {
  const { createStore } = jotai;

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("keeps the in-memory value when the write fails", () => {
    const testAtom = atomWithLocalStorage("dispatch:test:quota", "before");
    const store = createStore();
    const setItem = window.localStorage.setItem.bind(window.localStorage);
    const original = Object.getOwnPropertyDescriptor(
      Storage.prototype,
      "setItem"
    )!;
    Object.defineProperty(Storage.prototype, "setItem", {
      configurable: true,
      value: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    });
    try {
      expect(() => store.set(testAtom, "after")).not.toThrow();
      expect(store.get(testAtom)).toBe("after");
      expect(window.localStorage.getItem("dispatch:test:quota")).toBeNull();
    } finally {
      Object.defineProperty(Storage.prototype, "setItem", original);
    }
    setItem("dispatch:test:quota", JSON.stringify("later"));
    expect(window.localStorage.getItem("dispatch:test:quota")).toBe('"later"');
  });

  it("writes the serialized form and holds the value as set", () => {
    const testAtom = atomWithLocalStorage<string[]>(
      "dispatch:test:serialize",
      [],
      { serialize: (value) => JSON.stringify(value.slice(0, 1)) }
    );
    const store = createStore();
    store.set(testAtom, ["a", "b"]);
    expect(store.get(testAtom)).toEqual(["a", "b"]);
    expect(window.localStorage.getItem("dispatch:test:serialize")).toBe(
      '["a"]'
    );
  });

  it("leaves storage alone when an update hands back the current value", () => {
    // Another tab may have written since this tab read; a no-op update
    // must not echo this tab's stale copy over it.
    const testAtom = atomWithLocalStorage("dispatch:test:noop", "initial");
    const store = createStore();
    store.set(testAtom, "mine");
    window.localStorage.setItem("dispatch:test:noop", '"theirs"');
    store.set(testAtom, (prev) => prev);
    expect(store.get(testAtom)).toBe("mine");
    expect(window.localStorage.getItem("dispatch:test:noop")).toBe('"theirs"');
    store.set(testAtom, "changed");
    expect(window.localStorage.getItem("dispatch:test:noop")).toBe('"changed"');
  });

  it("reads a value that fails validation as the initial one", () => {
    window.localStorage.setItem("dispatch:test:validate", '"nope"');
    const testAtom = atomWithLocalStorage<number>("dispatch:test:validate", 7, {
      validate: (value): value is number => typeof value === "number",
    });
    expect(createStore().get(testAtom)).toBe(7);
  });
});
