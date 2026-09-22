// @vitest-environment jsdom
import * as jotai from "jotai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  reconcileAgentSidebarOrder,
  reconcileDrawerStateStorage,
  DRAWER_STATE_STORAGE_PREFIX,
  defaultDrawerState,
  reconcileDiffViewStateStorage,
  DIFF_VIEW_STATE_STORAGE_PREFIX,
  reconcileSplitPaneStateStorage,
  SPLIT_PANE_STATE_STORAGE_PREFIX,
  splitPaneStateAtomFamily,
  defaultSplitPaneState,
  atomWithLocalStorage,
  isSplitPaneState,
  asDrawerTab,
  reconcileAgentScopedStorage,
  REVIEW_DRAFTS_STORAGE_PREFIX,
  CHAT_SHOW_CHILD_AGENTS_STORAGE_KEY,
  chatShowChildAgentsAtom,
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

  it("maps a stored tab id to a live tab, falling back to the Inbox", () => {
    expect(asDrawerTab("files")).toBe("files");
    expect(asDrawerTab("inbox")).toBe("inbox");
    // Ids from before the cutover: the rail, pins and reviews tabs and surface ids.
    expect(asDrawerTab("rail")).toBe("inbox");
    expect(asDrawerTab("pins")).toBe("inbox");
    expect(asDrawerTab("reviews")).toBe("inbox");
    expect(asDrawerTab("srf_abc")).toBe("inbox");
    expect(asDrawerTab(undefined)).toBe("inbox");
  });

  it("reconciles all per-agent storage in one pass", () => {
    window.localStorage.setItem(`${DRAWER_STATE_STORAGE_PREFIX}agt_live`, "{}");
    window.localStorage.setItem(
      `${REVIEW_DRAFTS_STORAGE_PREFIX}agt_dead`,
      "{}"
    );
    window.localStorage.setItem(
      `${REVIEW_DRAFTS_STORAGE_PREFIX}agt_live`,
      "{}"
    );
    window.localStorage.setItem("dispatch:unrelated", "keep");

    reconcileAgentScopedStorage(["agt_live"]);

    expect(window.localStorage.getItem("dispatch:unrelated")).toBe("keep");
    expect(
      window.localStorage.getItem(`${REVIEW_DRAFTS_STORAGE_PREFIX}agt_dead`)
    ).toBeNull();
    expect(
      window.localStorage.getItem(`${REVIEW_DRAFTS_STORAGE_PREFIX}agt_live`)
    ).not.toBeNull();
    expect(
      window.localStorage.getItem(`${DRAWER_STATE_STORAGE_PREFIX}agt_live`)
    ).not.toBeNull();
  });
});

describe("reconcileDrawerStateStorage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  const storeForAgent = (agentId: string) => {
    window.localStorage.setItem(
      `${DRAWER_STATE_STORAGE_PREFIX}${agentId}`,
      JSON.stringify(defaultDrawerState)
    );
  };

  it("removes keys for agents not in the live set", () => {
    storeForAgent("agt_1");
    storeForAgent("agt_2");
    storeForAgent("agt_3");

    reconcileDrawerStateStorage(["agt_1", "agt_3"]);

    expect(
      window.localStorage.getItem(`${DRAWER_STATE_STORAGE_PREFIX}agt_1`)
    ).not.toBeNull();
    expect(
      window.localStorage.getItem(`${DRAWER_STATE_STORAGE_PREFIX}agt_2`)
    ).toBeNull();
    expect(
      window.localStorage.getItem(`${DRAWER_STATE_STORAGE_PREFIX}agt_3`)
    ).not.toBeNull();
  });

  it("does nothing when all stored agents are live", () => {
    storeForAgent("agt_1");
    storeForAgent("agt_2");

    reconcileDrawerStateStorage(["agt_1", "agt_2"]);

    expect(window.localStorage.length).toBe(2);
  });

  it("removes all drawer keys when live set is empty", () => {
    storeForAgent("agt_1");
    storeForAgent("agt_2");

    reconcileDrawerStateStorage([]);

    expect(window.localStorage.length).toBe(0);
  });

  it("does nothing when localStorage is empty", () => {
    reconcileDrawerStateStorage(["agt_1"]);

    expect(window.localStorage.length).toBe(0);
  });

  it("does not affect non-drawer keys", () => {
    window.localStorage.setItem("dispatch:leftSidebarOpen", "true");
    window.localStorage.setItem("unrelated-key", "value");
    storeForAgent("agt_dead");

    reconcileDrawerStateStorage([]);

    expect(window.localStorage.getItem("dispatch:leftSidebarOpen")).toBe(
      "true"
    );
    expect(window.localStorage.getItem("unrelated-key")).toBe("value");
    expect(
      window.localStorage.getItem(`${DRAWER_STATE_STORAGE_PREFIX}agt_dead`)
    ).toBeNull();
  });

  it("accepts a Set as agentIds", () => {
    storeForAgent("agt_1");
    storeForAgent("agt_2");

    reconcileDrawerStateStorage(new Set(["agt_1"]));

    expect(
      window.localStorage.getItem(`${DRAWER_STATE_STORAGE_PREFIX}agt_1`)
    ).not.toBeNull();
    expect(
      window.localStorage.getItem(`${DRAWER_STATE_STORAGE_PREFIX}agt_2`)
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
    window.localStorage.setItem(`${DRAWER_STATE_STORAGE_PREFIX}agt_live`, "{}");
    storeDiffForAgent("agt_dead");

    reconcileDiffViewStateStorage([]);

    expect(window.localStorage.getItem("dispatch:leftSidebarOpen")).toBe(
      "true"
    );
    expect(
      window.localStorage.getItem(`${DRAWER_STATE_STORAGE_PREFIX}agt_live`)
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
    left: "agent",
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
    window.localStorage.setItem(`${DRAWER_STATE_STORAGE_PREFIX}agt_live`, "{}");
    storeForAgent("agt_dead");

    reconcileSplitPaneStateStorage([]);

    expect(window.localStorage.getItem("dispatch:leftSidebarOpen")).toBe(
      "true"
    );
    expect(
      window.localStorage.getItem(`${DRAWER_STATE_STORAGE_PREFIX}agt_live`)
    ).toBe("{}");
    expect(
      window.localStorage.getItem(`${SPLIT_PANE_STATE_STORAGE_PREFIX}agt_dead`)
    ).toBeNull();
  });

  it("keeps the versioned key", () => {
    expect(SPLIT_PANE_STATE_STORAGE_PREFIX).toBe("dispatch:splitPaneV2:");
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

describe("splitPaneStateAtomFamily storage migration", () => {
  const { createStore } = jotai;

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
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
});

describe("isSplitPaneState", () => {
  it("accepts the current tab ids on either side, and nothing retired", () => {
    expect(
      isSplitPaneState({
        mode: "split",
        left: "changes",
        right: "agent",
        sizes: [30, 70],
      })
    ).toBe(true);
    expect(isSplitPaneState(defaultSplitPaneState)).toBe(true);
    expect(isSplitPaneState({ ...defaultSplitPaneState, left: "chat" })).toBe(
      false
    );
    expect(
      isSplitPaneState({ ...defaultSplitPaneState, right: "terminal" })
    ).toBe(false);
  });

  it("rejects anything else", () => {
    expect(isSplitPaneState(null)).toBe(false);
    expect(isSplitPaneState("split")).toBe(false);
    expect(isSplitPaneState({ ...defaultSplitPaneState, mode: "wide" })).toBe(
      false
    );
    expect(isSplitPaneState({ ...defaultSplitPaneState, left: "files" })).toBe(
      false
    );
    expect(isSplitPaneState({ ...defaultSplitPaneState, sizes: [50] })).toBe(
      false
    );
    expect(
      isSplitPaneState({ ...defaultSplitPaneState, sizes: ["a", 1] })
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

describe("chatShowChildAgentsAtom", () => {
  const { createStore } = jotai;

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("shows child-agent messages until the user says otherwise", () => {
    expect(createStore().get(chatShowChildAgentsAtom)).toBe(true);
  });

  it("persists the filter under one key, not one per agent", () => {
    const store = createStore();
    store.set(chatShowChildAgentsAtom, false);
    expect(store.get(chatShowChildAgentsAtom)).toBe(false);
    expect(
      window.localStorage.getItem(CHAT_SHOW_CHILD_AGENTS_STORAGE_KEY)
    ).toBe("false");
    expect(
      Object.keys(window.localStorage).filter((key) =>
        key.startsWith(`${CHAT_SHOW_CHILD_AGENTS_STORAGE_KEY}:`)
      )
    ).toEqual([]);
  });

  it("follows a flip made in another tab", () => {
    const store = createStore();
    // Subscribing mounts the atom, which is what installs the listener.
    const unsub = store.sub(chatShowChildAgentsAtom, () => {});
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: CHAT_SHOW_CHILD_AGENTS_STORAGE_KEY,
        newValue: "false",
        storageArea: window.localStorage,
      })
    );
    expect(store.get(chatShowChildAgentsAtom)).toBe(false);
    unsub();
  });
});
