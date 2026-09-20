// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigationType,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";

import { AgentsView } from "./agents-view";

// AgentsView is the wiring layer for the agents screen: fifteen hooks feed
// fourteen children, and almost nothing it renders is its own markup. Every
// hook and every child is therefore replaced — the hooks by values this file
// controls, the children by markers that record the props they were handed.
// What is left under test is the part AgentsView actually owns: which agent is
// "focused", the navigation its callbacks perform, and the effects that open
// the media sidebar.
const { H, stubModule, stubWrapper } = vi.hoisted(() => {
  const props = new Map<string, Record<string, unknown>>();
  const record = (name: string, received: Record<string, unknown>) => {
    props.set(name, received);
  };
  const H = {
    props,
    record,
    // Cleared between tests. A child that never mounted must read as absent
    // rather than handing back whatever the previous test recorded — an
    // assertion against a stale entry passes no matter what the component does.
    clearProps: () => props.clear(),
    // Mutable state every mocked hook reads at call time.
    state: {} as Record<string, unknown>,
  };
  const stubModule =
    (...exportNames: string[]) =>
    async () => {
      const React = await import("react");
      const mod: Record<string, unknown> = {};
      for (const name of exportNames) {
        mod[name] = (received: Record<string, unknown>) => {
          record(name, received);
          return React.createElement("div", { "data-testid": `stub-${name}` });
        };
      }
      return mod;
    };
  /** Children that wrap the tree still have to render what they are given. */
  const stubWrapper = (exportName: string) => async () => {
    const React = await import("react");
    return {
      [exportName]: (received: { children?: unknown }) => {
        record(exportName, received as Record<string, unknown>);
        return React.createElement(
          "div",
          { "data-testid": `stub-${exportName}` },
          received.children as never
        );
      },
    };
  };
  return { H, stubModule, stubWrapper };
});

// The mobile toolbar row animates in and out; without this the exiting child
// would linger in the tree and the mount/unmount assertions would read the
// animation rather than the view's decision.
vi.mock("framer-motion", async (importOriginal) => {
  const { createFramerMotionMock } =
    await import("@/test-utils/framer-motion-mock");
  return createFramerMotionMock(importOriginal);
});

vi.mock("@/components/app/changes-tab", stubModule("ChangesTab"));
vi.mock(
  "@/components/app/agent-pane",
  stubModule("AgentPane", "ChatFiltersButton")
);
vi.mock("@/components/app/split-drop-zones", stubModule("SplitDropZones"));
// The real split renders whichever panes it is handed into its two slots, so
// the stub does too — otherwise the elements AgentsView builds are only ever
// asserted as "not null", which a swap of the two would survive.
vi.mock("@/components/app/center-pane-split", async () => {
  const React = await import("react");
  return {
    CenterPaneSplit: (received: Record<string, unknown>) => {
      H.record("CenterPaneSplit", received);
      const slot = (tab: string) =>
        tab === "changes"
          ? (received.changesElement as never)
          : tab === "agent"
            ? (received.agentElement as never)
            : null;
      const splitState = received.splitState as { left: string; right: string };
      return React.createElement(
        "div",
        { "data-testid": "stub-CenterPaneSplit" },
        React.createElement(
          "div",
          { "data-testid": "split-left" },
          slot(splitState.left)
        ),
        React.createElement(
          "div",
          { "data-testid": "split-right" },
          slot(splitState.right)
        )
      );
    },
  };
});
vi.mock("@/components/app/agent-sidebar", stubModule("AgentListContent"));
vi.mock("@/components/app/agents-view-header", stubModule("AgentsViewHeader"));
vi.mock(
  "@/components/app/agents-view-dialogs",
  stubModule("AgentsViewDialogs")
);
vi.mock(
  "@/components/app/media-sidebar",
  stubModule("MediaSidebar", "MediaSidebarContent")
);
vi.mock("@/components/app/bottom-bar", stubModule("BottomBar"));
vi.mock("@/components/app/sidebar-shell", stubWrapper("SidebarShell"));
// Recorded rather than left real: the mobile slide-over can only ever call
// onOpenChange(false) from its backdrop, so the open branch of AgentsView's
// handler is unreachable through the real primitive.
vi.mock("@/components/ui/glass-sidebar", async () => {
  const React = await import("react");
  return {
    GlassSidebar: (received: { label?: string; children?: unknown }) => {
      H.record(`GlassSidebar:${received.label}`, received);
      return React.createElement(
        "div",
        { "data-testid": `stub-GlassSidebar:${received.label}` },
        received.children as never
      );
    },
  };
});

vi.mock("@/lib/media-upload", () => ({
  uploadAgentMedia: vi.fn(async () => undefined),
}));

vi.mock("@/hooks/use-agents", () => ({
  useAgents: (enabled: boolean, routeAgentId: string | null) => {
    H.record("useAgents", { enabled, routeAgentId });
    const s = H.state;
    return {
      agents: s.agents,
      agentsLoaded: s.agentsLoaded,
      validatedSelectedAgentId: s.validatedSelectedAgentId,
      selectedAgent: s.selectedAgent,
      overflowAgentId: null,
      setOverflowAgentId: s.setOverflowAgentId,
      agentVisualState: s.agentVisualState,
      resortAgents: s.resortAgents,
    };
  },
}));

vi.mock("@/hooks/use-agents-view-routing", () => ({
  useAgentsViewRouting: (args: unknown) => {
    H.record("useAgentsViewRouting", args as Record<string, unknown>);
    const s = H.state;
    return {
      changesMatch: s.changesMatch,
      centerTabResolved: s.centerTabResolved ?? true,
      onTabChange: s.onTabChange,
    };
  },
}));

vi.mock("@/hooks/use-chat-unread-summary", () => ({
  useAgentChatUnread: () => ({ unread: 0, pendingQuestions: 0 }),
}));

vi.mock("@/hooks/use-expanded-agent", () => ({
  useExpandedAgent: () => {
    const s = H.state;
    return {
      expandedAgentId: s.expandedAgentId,
      setExpandedAgentId: s.setExpandedAgentId,
      toggleAgentDetails: s.toggleAgentDetails,
    };
  },
  useExpandedAgentSync: vi.fn(),
}));

vi.mock("@/hooks/use-media-sidebar-state", () => ({
  useMediaSidebarState: (args: unknown) => {
    H.record("useMediaSidebarState", args as Record<string, unknown>);
    const s = H.state;
    return {
      mediaOpen: s.mediaOpen,
      mediaPanelOpen: s.mediaPanelOpen,
      mediaActiveTab: s.mediaActiveTab,
      mediaPinned: false,
      setMediaOpen: s.setMediaOpen,
      setMediaActiveTab: s.setMediaActiveTab,
      toggleMediaPinned: s.toggleMediaPinned,
      finishMediaResizeSettle: s.finishMediaResizeSettle,
    };
  },
}));

vi.mock("@/hooks/use-center-pane-layout", () => ({
  useCenterPaneLayout: (args: unknown) => {
    H.record("useCenterPaneLayout", args as Record<string, unknown>);
    const s = H.state;
    return {
      splitState: s.splitState,
      isSplit: s.isSplit,
      exitSplit: s.exitSplit,
      isDraggingTab: false,
      splitLeftRef: s.splitLeftRef,
      splitButtonRef: s.splitButtonRef,
      handleContentDragOver: s.unused,
      handleContentDragLeave: s.unused,
      handleContentDrop: s.unused,
      handleDropOnZone: s.unused,
      handleSplitLayoutChange: s.unused,
    };
  },
}));

vi.mock("@/hooks/use-media", () => ({
  useMedia: (agentId: string | null, panelOpen: boolean) => {
    H.record("useMedia", { agentId, panelOpen });
    const s = H.state;
    return {
      mediaFiles: s.mediaFiles,
      animatingMediaKeys: new Set<string>(),
      unseenMediaCount: 0,
      lightboxMediaId: null,
      lightboxMediaIds: [],
      setLightboxMediaId: s.unused,
      openLightbox: s.unused,
      mediaViewportRef: s.mediaViewportRef,
      refreshMedia: s.refreshMedia,
    };
  },
}));

vi.mock("@/hooks/use-stream-rail", () => ({
  useStreamRail: (agentId: string | null) => {
    H.record("useStreamRail", { agentId });
    const s = H.state;
    return {
      rootId: agentId,
      inputs: (s.railInputs as unknown[]) ?? [],
      links: [],
      isLoading: false,
    };
  },
}));

vi.mock("@/hooks/use-agent-focus", () => ({ useAgentFocus: vi.fn() }));

vi.mock("@/hooks/use-agent-diff-stats", () => ({
  useVisibleDiffStats: (
    agentId: string,
    enabled: boolean,
    changesVisible: boolean
  ) => {
    H.record("useVisibleDiffStats", { agentId, enabled, changesVisible });
    return { diffStats: undefined, refresh: H.state.unused };
  },
}));

vi.mock("@/hooks/use-agent-actions", () => ({
  useAgentActions: (args: unknown) => {
    H.record("useAgentActions", args as Record<string, unknown>);
    const s = H.state;
    return {
      openAgent: s.unused,
      startAgent: s.unused,
      stopAgent: s.unused,
      deleteAgent: s.unused,
      handleAgentCreated: s.unused,
      closeAgentAndClearSelection: s.unused,
    };
  },
}));

vi.mock("@/hooks/use-agent-hotkeys", () => ({
  useAgentHotkeys: (args: unknown) => {
    H.record("useAgentHotkeys", args as Record<string, unknown>);
    const s = H.state;
    return {
      paletteOpen: false,
      setPaletteOpen: s.unused,
      paletteActions: [],
      paletteGroups: [],
      launchTemplate: null,
      setLaunchTemplateId: s.unused,
    };
  },
}));

function makeAgent(overrides: Partial<Agent> & { id: string }): Agent {
  return {
    name: `agent ${overrides.id}`,
    status: "running",
    cwd: `/repos/${overrides.id}`,
    worktreePath: null,
    worktreeBranch: null,
    agentArgs: [],
    model: null,
    fullAccess: false,
    mediaDir: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function LocationProbe(): JSX.Element {
  const location = useLocation();
  const navigationType = useNavigationType();
  return (
    <>
      <span data-testid="location">{`${location.pathname}${location.search}`}</span>
      <span data-testid="navigation-type">{navigationType}</span>
    </>
  );
}

function locationHref(): string {
  return screen.getByTestId("location").textContent ?? "";
}

/** "PUSH" leaves the previous entry in history; "REPLACE" discards it. */
function navigationType(): string {
  return screen.getByTestId("navigation-type").textContent ?? "";
}

/** Names of the stubbed children currently mounted, in document order. */
function renderedChildren(): string[] {
  return Array.from(document.querySelectorAll("[data-testid^='stub-']")).map(
    (el) => el.getAttribute("data-testid")!.replace("stub-", "")
  );
}

function propsOf(name: string): Record<string, unknown> {
  expect(renderedChildren()).toContain(name);
  const received = H.props.get(name);
  if (!received) throw new Error(`${name} recorded no props`);
  return received;
}

/**
 * Arguments the component handed a mocked hook. Hooks leave no DOM to guard
 * on, so freshness rests on the map being cleared in beforeEach: an entry can
 * only exist because this test's render produced it.
 */
function hookArgs(name: string): Record<string, unknown> {
  const received = H.props.get(name);
  if (!received) throw new Error(`${name} was never called`);
  return received;
}

beforeEach(() => {
  H.clearProps();
  window.localStorage.clear();
  H.state = {
    // One stable placeholder for the callbacks no assertion reads. Named so a
    // future `toHaveBeenCalled` on it is obviously meaningless.
    unused: vi.fn(),
    agents: [] as Agent[],
    agentsLoaded: true,
    validatedSelectedAgentId: null,
    selectedAgent: null,
    setOverflowAgentId: vi.fn(),
    agentVisualState: () => "idle",
    resortAgents: vi.fn(),
    changesMatch: false,
    onTabChange: vi.fn(),
    expandedAgentId: null,
    setExpandedAgentId: vi.fn(),
    toggleAgentDetails: vi.fn(),
    mediaOpen: false,
    mediaPanelOpen: false,
    mediaActiveTab: "media",
    setMediaOpen: vi.fn(),
    setMediaActiveTab: vi.fn(),
    toggleMediaPinned: vi.fn(),
    finishMediaResizeSettle: vi.fn(),
    splitState: { left: "agent", right: "agent" },
    isSplit: false,
    exitSplit: vi.fn(),
    splitLeftRef: { current: null },
    splitButtonRef: { current: null },
    mediaFiles: [],
    mediaViewportRef: { current: null },
    refreshMedia: vi.fn(),
    agentSurfaces: [] as Array<{ id: string }>,
    surfaceSeenIds: [] as string[],
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type ViewProps = Parameters<typeof AgentsView>[0];

function mount({
  path = "/agents/a1",
  ...overrides
}: Partial<ViewProps> & { path?: string } = {}) {
  const props: ViewProps = {
    enabledAgentTypes: ["claude"],
    enabledIdes: ["vscode"],
    isMobile: false,
    leftOpen: true,
    leftPanelOpen: true,
    mobileLeftOpen: false,
    mobileMediaOpen: false,
    setLeftOpen: vi.fn(),
    setMobileLeftOpen: vi.fn(),
    setMobileMediaOpen: vi.fn(),
    handleSetLeftPanelOpen: vi.fn(),
    pulsingNavItem: null,
    triggerNavAnimation: vi.fn(),
    onNavigateSection: vi.fn(),
    ...overrides,
  };
  const view = render(tree(path, props));
  return { ...view, props };
}

function tree(path: string, props: ViewProps): JSX.Element {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/agents/*" element={<AgentsView {...props} />} />
        <Route path="/agents/:agentId/*" element={<AgentsView {...props} />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>
  );
}

describe("AgentsView focused agent", () => {
  it("follows the selected agent", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" }), makeAgent({ id: "a2" })],
      validatedSelectedAgentId: "a2",
    });
    mount({ path: "/agents/a2" });

    expect(propsOf("AgentsViewHeader").focusedAgentId).toBe("a2");
    expect(propsOf("AgentsViewHeader").focusedAgentName).toBe("agent a2");
    expect(propsOf("MediaSidebar").selectedAgentId).toBe("a2");
  });
});

describe("AgentsView agent pane", () => {
  function focusOn(agentId: string) {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" }), makeAgent({ id: "a2" })],
      validatedSelectedAgentId: agentId,
    });
  }

  it("renders the Agent pane with its header for the focused agent", () => {
    focusOn("a1");
    mount({ path: "/agents/a1" });
    expect(propsOf("AgentPane").header).toBe(true);
    expect(propsOf("AgentPane").agentId).toBe("a1");
    expect(propsOf("AgentPane").active).toBe(true);
    expect(propsOf("AgentsViewHeader").activeTab).toBe("agent");
  });

  it("keeps the pane mounted but inactive under the Changes tab", () => {
    focusOn("a1");
    H.state.changesMatch = true;
    mount({ path: "/agents/a1/changes" });
    expect(propsOf("AgentPane").active).toBe(false);
    expect(renderedChildren()).toContain("ChangesTab");
  });

  it("holds the pane inactive until the center tab is resolved", () => {
    focusOn("a1");
    H.state.centerTabResolved = false;
    mount({ path: "/agents/a1/chat" });
    expect(propsOf("AgentPane").active).toBe(false);
    expect(propsOf("AgentsViewHeader").centerTabResolved).toBe(false);
  });

  it("hands the Agent pane and the chat filters to the split slot", () => {
    focusOn("a1");
    Object.assign(H.state, {
      isSplit: true,
      splitState: { left: "agent", right: "changes" },
    });
    mount({ path: "/agents/a1" });
    expect(propsOf("AgentPane").header).toBe(false);
    expect(propsOf("CenterPaneSplit").agentElement).not.toBeNull();
    expect(propsOf("CenterPaneSplit").agentHeaderAccessory).not.toBeNull();
  });

  it("gives the split no Agent pane when neither slot shows it", () => {
    focusOn("a1");
    Object.assign(H.state, {
      isSplit: true,
      splitState: { left: "changes", right: "changes" },
    });
    mount({ path: "/agents/a1" });
    expect(propsOf("CenterPaneSplit").agentElement).toBeNull();
    expect(propsOf("CenterPaneSplit").agentHeaderAccessory).toBeNull();
  });
});

describe("AgentsView file navigation", () => {
  function mountWithFocus(overrides: Partial<ViewProps> = {}) {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
    });
    return mount(overrides);
  }

  function navigateToFile(...args: unknown[]) {
    const handler = propsOf("AgentPane").onOpenPath as (
      ...a: unknown[]
    ) => void;
    act(() => handler(...args));
  }

  it("routes to the changes tab with the file and line, replacing history", () => {
    mountWithFocus();

    navigateToFile("src/app.ts", 42);

    expect(locationHref()).toBe("/agents/a1/changes?file=src%2Fapp.ts&line=42");
    // A push here would leave the pre-navigation entry behind, so Back would
    // land on the same screen the user is already looking at.
    expect(navigationType()).toBe("REPLACE");
  });

  it("closes the mobile media sidebar it navigated out of", () => {
    const { props } = mountWithFocus({ isMobile: true });

    navigateToFile("src/app.ts", 1);

    expect(props.setMobileMediaOpen).toHaveBeenCalledWith(false);
  });

  it("leaves the mobile sidebar alone on desktop", () => {
    const { props } = mountWithFocus({ isMobile: false });

    navigateToFile("src/app.ts", 1);

    expect(props.setMobileMediaOpen).not.toHaveBeenCalled();
  });

  it("does not navigate when nothing is focused", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: null,
    });
    mount({ path: "/agents" });

    navigateToFile("src/app.ts", 42);

    expect(locationHref()).toBe("/agents");
  });
});

describe("AgentsView media sidebar", () => {
  it("opens the sidebar when the focused agent starts streaming", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1", hasStream: false })],
      validatedSelectedAgentId: "a1",
    });
    const { rerender, props } = mount();
    expect(H.state.setMediaOpen).not.toHaveBeenCalled();

    H.state.agents = [makeAgent({ id: "a1", hasStream: true })];
    rerender(tree("/agents/a1", props));

    expect(H.state.setMediaOpen).toHaveBeenCalledWith(true);
  });

  it("does not re-open the sidebar for a stream that was already running", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1", hasStream: true })],
      validatedSelectedAgentId: "a1",
    });
    mount();

    expect(H.state.setMediaOpen).not.toHaveBeenCalled();
    expect(propsOf("MediaSidebar").hasStream).toBe(true);
    expect(propsOf("MediaSidebar").streamUrl).toBe("/api/v1/agents/a1/stream");
  });

  it("keeps the sidebar shut when no agent is selected", () => {
    Object.assign(H.state, {
      agents: [],
      validatedSelectedAgentId: null,
      mediaOpen: true,
    });
    mount({ path: "/agents" });

    expect(propsOf("MediaSidebar").mediaOpen).toBe(false);
    expect(propsOf("MediaSidebar").streamUrl).toBeNull();
  });
});

describe("AgentsView center pane", () => {
  it("renders the changes pane from the split layout without a changes route", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
      isSplit: true,
      splitState: { left: "agent", right: "changes" },
    });
    mount({ path: "/agents/a1" });

    expect(renderedChildren()).toContain("ChangesTab");
  });

  it("renders the changes pane from the split layout's left slot", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
      isSplit: true,
      splitState: { left: "changes", right: "agent" },
    });
    mount({ path: "/agents/a1" });

    expect(renderedChildren()).toContain("ChangesTab");
    expect(propsOf("ChangesTab").agentId).toBe("a1");
  });

  it("ignores the route matches while split, so a stale route cannot double-render", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
      isSplit: true,
      splitState: { left: "agent", right: "agent" },
      changesMatch: true,
    });
    mount({ path: "/agents/a1/changes" });

    expect(renderedChildren()).not.toContain("ChangesTab");
    // The split's own slots decide what is mounted, so the pane has to be
    // absent at the source: a pane built from a stale route match would be
    // handed to the split and appear the moment a slot switched to it.
    expect(propsOf("CenterPaneSplit").changesElement).toBeNull();
  });
});

describe("AgentsView dialogs", () => {
  it("resolves the create dialog's cwd from the selected agent first", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a3", cwd: "/repos/newest" })],
      validatedSelectedAgentId: "a1",
      selectedAgent: makeAgent({ id: "a1", cwd: "/repos/selected" }),
    });
    mount();

    const resolve = propsOf("AgentsViewDialogs")
      .resolveCreateDefaultCwd as () => string;
    expect(resolve()).toBe("/repos/selected");
  });

  it("falls back to the newest agent, then nothing", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a3", cwd: "/repos/newest" })],
      validatedSelectedAgentId: null,
      selectedAgent: null,
    });
    mount({ path: "/agents" });
    expect(
      (propsOf("AgentsViewDialogs").resolveCreateDefaultCwd as () => string)()
    ).toBe("/repos/newest");

    cleanup();
    H.clearProps();
    H.state.agents = [];
    mount({ path: "/agents" });
    expect(
      (propsOf("AgentsViewDialogs").resolveCreateDefaultCwd as () => string)()
    ).toBe("");
  });

  it("clears a requested agent type when the create dialog closes", () => {
    Object.assign(H.state, { agents: [], validatedSelectedAgentId: null });
    mount({ path: "/agents" });

    act(() =>
      (propsOf("AgentListContent").onOpenCreateDialog as (t: string) => void)(
        "codex"
      )
    );
    expect(propsOf("AgentsViewDialogs").createOpen).toBe(true);
    expect(propsOf("AgentsViewDialogs").initialAgentType).toBe("codex");

    act(() =>
      (propsOf("AgentsViewDialogs").onCreateOpenChange as (o: boolean) => void)(
        false
      )
    );
    expect(propsOf("AgentsViewDialogs").createOpen).toBe(false);
    expect(propsOf("AgentsViewDialogs").initialAgentType).toBeNull();
  });

  it("opens the create dialog without touching the sidebar on desktop", () => {
    Object.assign(H.state, { agents: [], validatedSelectedAgentId: null });
    const { props } = mount({ path: "/agents", isMobile: false });

    act(() =>
      (propsOf("AgentListContent").onOpenCreateDialog as (t?: string) => void)()
    );

    expect(propsOf("AgentsViewDialogs").createOpen).toBe(true);
    expect(props.setMobileLeftOpen).not.toHaveBeenCalled();
  });

  it("closes the mobile sidebar before opening the create dialog", () => {
    Object.assign(H.state, { agents: [], validatedSelectedAgentId: null });
    const { props } = mount({ path: "/agents", isMobile: true });

    act(() =>
      (propsOf("AgentListContent").onOpenCreateDialog as (t?: string) => void)()
    );

    expect(props.setMobileLeftOpen).toHaveBeenCalledWith(false);
    expect(propsOf("AgentsViewDialogs").createOpen).toBe(true);
  });
});

describe("AgentsView mobile chrome", () => {
  it("leaves the bottom bar off on mobile", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
    });
    mount({ isMobile: true });

    expect(renderedChildren()).not.toContain("BottomBar");
  });

  it("mounts the desktop chrome on a wide screen", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
    });
    mount({ isMobile: false });

    expect(renderedChildren()).toContain("BottomBar");
    expect(renderedChildren()).not.toContain("MediaSidebarContent");
  });

  it("colors only the active agent's row border", () => {
    mount({ path: "/agents" });

    const border = propsOf("AgentListContent").borderForAgentState as (
      s: string
    ) => string;
    expect(border("active")).toBe("border-r-status-done");
    expect(border("idle")).toBe("border-r-transparent");
  });
});

describe("AgentsView hook wiring", () => {
  it("hands the route's agent to the agents list", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" }), makeAgent({ id: "a2" })],
      validatedSelectedAgentId: "a1",
    });
    mount();

    expect(hookArgs("useAgents").routeAgentId).toBe("a1");
  });

  it("keys the media sidebar off the selected agent", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" }), makeAgent({ id: "a2" })],
      validatedSelectedAgentId: "a2",
    });
    mount({ path: "/agents/a2" });

    expect(hookArgs("useMediaSidebarState").sidebarAgentId).toBe("a2");
    expect(hookArgs("useMediaSidebarState").agentIds).toEqual(["a1", "a2"]);
  });

  it("withholds the agent ids until the list has actually loaded", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      agentsLoaded: false,
      validatedSelectedAgentId: "a1",
    });
    mount();

    // Handing over ids from an unsettled list would let the sidebar prune
    // per-agent state for agents that simply have not arrived yet.
    expect(hookArgs("useMediaSidebarState").agentIds).toEqual([]);
  });

  it("swaps the left sidebar's close target between mobile and desktop", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
    });
    const desktop = mount();
    act(() => (propsOf("SidebarShell").onRequestClose as () => void)());
    expect(desktop.props.setLeftOpen).toHaveBeenCalledWith(false);
    expect(desktop.props.setMobileLeftOpen).not.toHaveBeenCalled();

    cleanup();
    H.clearProps();
    const mobile = mount({ isMobile: true });
    act(() => (propsOf("SidebarShell").onRequestClose as () => void)());
    expect(mobile.props.setMobileLeftOpen).toHaveBeenCalledWith(false);
    expect(mobile.props.setLeftOpen).not.toHaveBeenCalled();
  });

  it("closes the mobile media sidebar when the nav sidebar opens over it", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
    });
    const { props } = mount({ isMobile: true });

    const onOpenChange = propsOf("GlassSidebar:Navigation sidebar")
      .onOpenChange as (open: boolean) => void;
    act(() => onOpenChange(true));

    // Both slide-overs are full-screen on mobile, so opening one has to shut
    // the other or the user ends up with a hidden sidebar behind the visible.
    expect(props.setMobileMediaOpen).toHaveBeenCalledWith(false);
    expect(props.setMobileLeftOpen).toHaveBeenCalledWith(true);
  });

  it("does not touch the mobile sidebars when the desktop panel toggles", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
    });
    const { props } = mount({ isMobile: false });

    act(() =>
      (
        propsOf("GlassSidebar:Navigation sidebar").onOpenChange as (
          open: boolean
        ) => void
      )(false)
    );

    expect(props.setLeftOpen).toHaveBeenCalledWith(false);
    expect(props.setMobileMediaOpen).not.toHaveBeenCalled();
    expect(props.setMobileLeftOpen).not.toHaveBeenCalled();
  });
});
