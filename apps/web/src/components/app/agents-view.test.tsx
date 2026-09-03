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

import { getDefaultStore } from "jotai";

import { whiteboardAgentDrewAtomFamily } from "@/lib/store";
import type { Agent } from "@/components/app/types";

import { AgentsView } from "./agents-view";

// AgentsView is the wiring layer for the agents screen: fifteen hooks feed
// fourteen children, and almost nothing it renders is its own markup. Every
// hook and every child is therefore replaced — the hooks by values this file
// controls, the children by markers that record the props they were handed.
// What is left under test is the part AgentsView actually owns: which agent is
// "focused", the navigation its callbacks perform, and the effects that open
// the media sidebar, attach, and detach.
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

vi.mock("@/components/app/changes-tab", stubModule("ChangesTab"));
vi.mock("@/components/app/chat/chat-pane", stubModule("ChatPane"));
vi.mock("@/components/app/whiteboard-pane", stubModule("WhiteboardPane"));
vi.mock("@/components/app/split-drop-zones", stubModule("SplitDropZones"));
// The real split renders whichever panes it is handed into its two slots, so
// the stub does too — otherwise the elements AgentsView builds are only ever
// asserted as "not null", which a swap of the two would survive.
vi.mock("@/components/app/center-pane-split", async () => {
  const React = await import("react");
  return {
    CenterPaneSplit: (received: Record<string, unknown>) => {
      H.record("CenterPaneSplit", received);
      return React.createElement(
        "div",
        { "data-testid": "stub-CenterPaneSplit" },
        React.createElement(
          "div",
          { "data-testid": "split-left" },
          (received.splitState as { left: string }).left === "changes"
            ? (received.changesElement as never)
            : (received.splitState as { left: string }).left === "whiteboard"
              ? (received.whiteboardElement as never)
              : null
        ),
        React.createElement(
          "div",
          { "data-testid": "split-right" },
          (received.splitState as { right: string }).right === "changes"
            ? (received.changesElement as never)
            : (received.splitState as { right: string }).right === "whiteboard"
              ? (received.whiteboardElement as never)
              : null
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
vi.mock(
  "@/components/app/terminal-copy-mode-banner",
  stubModule("TerminalCopyModeBannerLayer")
);
vi.mock(
  "@/components/app/mobile-terminal-toolbar",
  stubModule("MobileTerminalToolbar")
);
vi.mock("@/components/app/terminal-pane", stubModule("TerminalPane"));
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
  useAgents: (
    sharedConnectedAgentId: string | null,
    sharedConnState: string,
    enabled: boolean,
    routeAgentId: string | null
  ) => {
    H.record("useAgents", {
      sharedConnectedAgentId,
      sharedConnState,
      enabled,
      routeAgentId,
    });
    const s = H.state;
    return {
      agents: s.agents,
      agentsLoaded: s.agentsLoaded,
      validatedSelectedAgentId: s.validatedSelectedAgentId,
      selectedAgent: s.selectedAgent,
      connectedAgent: s.connectedAgent,
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
      whiteboardMatch: s.whiteboardMatch,
      chatMatch: s.chatMatch ?? false,
      onTabChange: s.onTabChange,
    };
  },
}));

vi.mock("@/hooks/use-chat-surface-enabled", () => ({
  useChatSurfaceEnabled: () => ({
    enabled: H.state.chatEnabled ?? false,
    loaded: true,
  }),
}));

vi.mock("@/hooks/use-chat", () => ({
  useChatUnreadCount: () => 0,
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
      deferMediaResize: false,
      mediaResizeSettleKey: 0,
      setMediaOpen: s.setMediaOpen,
      setMediaActiveTab: s.setMediaActiveTab,
      toggleMediaPinned: s.toggleMediaPinned,
      finishMediaResizeSettle: s.finishMediaResizeSettle,
    };
  },
}));

vi.mock("@/hooks/use-terminal", () => ({
  useTerminal: (args: unknown) => {
    H.record("useTerminal", args as Record<string, unknown>);
    const s = H.state;
    return {
      connState: s.connState,
      connectedAgentId: s.connectedAgentId,
      terminalMode: s.terminalMode,
      terminalPlaceholderMessage: null,
      copyMode: s.copyMode,
      statusMessage: "",
      terminalHostRef: s.terminalHostRef,
      ctrlPendingRef: s.ctrlPendingRef,
      focusTerminal: s.focusTerminal,
      ensureTerminalConnected: s.ensureTerminalConnected,
      detachTerminal: s.detachTerminal,
      sendTerminalInput: s.sendTerminalInput,
      exitCopyMode: s.exitCopyMode,
      resyncing: s.resyncing,
      draggingFiles: false,
      uploadingFiles: false,
      terminalInputAtRef: s.terminalInputAtRef,
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
      defaultTerminalSlotRef: s.defaultTerminalSlotRef,
      splitTerminalSlotRef: s.splitTerminalSlotRef,
      stableTerminalContainer: s.stableTerminalContainer,
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
      lightboxIndex: null,
      lightboxItem: null,
      setLightboxIndex: s.unused,
      openLightbox: s.unused,
      mediaViewportRef: s.mediaViewportRef,
      refreshMedia: s.refreshMedia,
    };
  },
}));

vi.mock("@/hooks/use-agent-messages", () => ({
  useAgentUnreadCount: () => 0,
  useMarkMessagesRead: (agentId: string | null) => {
    H.record("useMarkMessagesRead", { agentId });
    return H.state.markMessagesRead;
  },
}));

vi.mock("@/hooks/use-agent-surfaces", () => ({
  useAgentSurfaces: (agentId: string | null) => {
    H.record("useAgentSurfaces", { agentId });
    const s = H.state;
    return {
      surfaces: (s.agentSurfaces as Array<{ id: string }>) ?? [],
      isLoading: false,
      isError: false,
      refetch: s.unused,
    };
  },
}));

vi.mock("@/components/app/agent-surfaces/use-surface-seen", () => ({
  useSurfaceSeen: (agentId: string | null) => {
    H.record("useSurfaceSeen", { agentId });
    const seen = (H.state.surfaceSeenIds as string[]) ?? [];
    return {
      isNew: (id: string) => !seen.includes(id),
      markSeen: H.state.unused,
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
      attachToAgent: s.unused,
      startAgent: s.unused,
      stopAgent: s.unused,
      deleteAgent: s.unused,
      handleAgentCreated: s.unused,
      detachAndClearSelection: s.unused,
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
    tmuxSession: null,
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

function terminalContainer(): HTMLElement {
  return document.getElementById("stable-terminal")!;
}

beforeEach(() => {
  H.clearProps();
  const container = document.createElement("div");
  container.id = "stable-terminal";
  document.body.appendChild(container);
  H.state = {
    // One stable placeholder for the callbacks no assertion reads. Named so a
    // future `toHaveBeenCalled` on it is obviously meaningless.
    unused: vi.fn(),
    agents: [] as Agent[],
    agentsLoaded: true,
    validatedSelectedAgentId: null,
    selectedAgent: null,
    connectedAgent: null,
    setOverflowAgentId: vi.fn(),
    agentVisualState: () => "idle",
    resortAgents: vi.fn(),
    changesMatch: false,
    whiteboardMatch: false,
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
    connState: "disconnected",
    connectedAgentId: null,
    terminalMode: "tmux",
    copyMode: "off",
    terminalHostRef: { current: null },
    ctrlPendingRef: { current: false },
    terminalInputAtRef: { current: 0 },
    focusTerminal: vi.fn(),
    ensureTerminalConnected: vi.fn(),
    detachTerminal: vi.fn(),
    sendTerminalInput: vi.fn(),
    exitCopyMode: vi.fn(),
    resyncing: false,
    splitState: { left: "terminal", right: "terminal" },
    isSplit: false,
    exitSplit: vi.fn(),
    splitLeftRef: { current: null },
    splitButtonRef: { current: null },
    defaultTerminalSlotRef: { current: null },
    splitTerminalSlotRef: { current: null },
    stableTerminalContainer: container,
    mediaFiles: [],
    mediaViewportRef: { current: null },
    refreshMedia: vi.fn(),
    markMessagesRead: vi.fn(),
    agentSurfaces: [] as Array<{ id: string }>,
    surfaceSeenIds: [] as string[],
  };
});

afterEach(() => {
  cleanup();
  document.getElementById("stable-terminal")?.remove();
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
    theme: "cool-navy",
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
  it("follows the connected agent, not the selected one, while attached", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" }), makeAgent({ id: "a2" })],
      validatedSelectedAgentId: "a1",
      connState: "connected",
      connectedAgentId: "a2",
    });
    mount();

    expect(propsOf("AgentsViewHeader").focusedAgentId).toBe("a2");
    expect(propsOf("AgentsViewHeader").focusedAgentName).toBe("agent a2");
    expect(propsOf("MediaSidebar").selectedAgentId).toBe("a2");
  });

  it("counts unseen agent-authored surfaces into the header's closed-sidebar badge", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
      connState: "connected",
      connectedAgentId: "a1",
      agentSurfaces: [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
      surfaceSeenIds: ["s2"],
    });
    mount();

    // s1 and s3 are unseen; s2 was already viewed — reuses the same
    // seen-state atom the tab strip itself reads, no duplicate server state.
    expect(propsOf("AgentsViewHeader").unseenSurfaceCount).toBe(2);
  });

  it("pins focus to the selected agent while the terminal is resyncing", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" }), makeAgent({ id: "a2" })],
      validatedSelectedAgentId: "a1",
      connState: "connected",
      connectedAgentId: "a2",
      resyncing: true,
    });
    mount();

    expect(propsOf("AgentsViewHeader").focusedAgentId).toBe("a1");
  });

  it("falls back to the selected agent while reconnecting with nothing attached", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
      connState: "reconnecting",
      connectedAgentId: null,
    });
    mount();

    expect(propsOf("AgentsViewHeader").focusedAgentId).toBe("a1");
  });

  it("has no focused agent while disconnected, even with one selected", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
      connState: "disconnected",
      connectedAgentId: "a1",
    });
    mount();

    expect(propsOf("AgentsViewHeader").focusedAgentId).toBeNull();
    expect(propsOf("AgentsViewHeader").focusedAgentName).toBeNull();
    // hasActiveAgent is derived from the selection, not from focus, so the
    // header still reports an active agent while the terminal is detached.
    expect(propsOf("AgentsViewHeader").hasActiveAgent).toBe(true);
  });
});

describe("AgentsView file navigation", () => {
  function mountWithFocus(overrides: Partial<ViewProps> = {}) {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
      connState: "connected",
      connectedAgentId: "a1",
    });
    return mount(overrides);
  }

  function navigateToFile(...args: unknown[]) {
    const handler = propsOf("MediaSidebar").onNavigateToFile as (
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

  it("omits the line and carries a feedback item when one is given", () => {
    mountWithFocus();

    navigateToFile("src/app.ts", null, 7);

    expect(locationHref()).toBe(
      "/agents/a1/changes?file=src%2Fapp.ts&feedback=7"
    );
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
      validatedSelectedAgentId: "a1",
      connState: "disconnected",
    });
    mount();

    navigateToFile("src/app.ts", 42);

    expect(locationHref()).toBe("/agents/a1");
  });
});

describe("AgentsView review navigation", () => {
  it("opens the reviews tab on the focused agent after a review is submitted", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
      connState: "connected",
      connectedAgentId: "a1",
      changesMatch: true,
    });
    mount({ path: "/agents/a1/changes" });

    act(() =>
      (propsOf("ChangesTab").onReviewSubmitted as (id: number) => void)(31)
    );

    expect(locationHref()).toBe("/agents/a1?expandReview=31");
    expect(navigationType()).toBe("REPLACE");
    expect(H.state.setMediaOpen).toHaveBeenCalledWith(true);
    expect(H.state.setMediaActiveTab).toHaveBeenCalledWith("reviews");
  });

  it("jumps from a reviewer to its parent's review, keeping the reviewer in history", () => {
    const reviewer = makeAgent({
      id: "rev1",
      parentAgentId: "a1",
      submittedReviewId: 9,
    });
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" }), reviewer],
      validatedSelectedAgentId: "rev1",
      connState: "connected",
      connectedAgentId: "rev1",
    });
    const { props } = mount({ path: "/agents/rev1", isMobile: true });

    act(() =>
      (propsOf("AgentListContent").openSubmittedReview as (a: Agent) => void)(
        reviewer
      )
    );

    expect(locationHref()).toBe("/agents/a1?expandReview=9");
    // Unlike a submit, this is a jump to a different agent: Back must return
    // the user to the reviewer they came from.
    expect(navigationType()).toBe("PUSH");
    expect(H.state.setExpandedAgentId).toHaveBeenCalledWith("a1");
    expect(H.state.setMediaActiveTab).toHaveBeenCalledWith("reviews");
    expect(props.setMobileLeftOpen).toHaveBeenCalledWith(false);
  });

  it("ignores a reviewer that has not submitted a review yet", () => {
    const reviewer = makeAgent({
      id: "rev1",
      parentAgentId: "a1",
      submittedReviewId: null,
    });
    Object.assign(H.state, {
      agents: [reviewer],
      validatedSelectedAgentId: "rev1",
      connState: "connected",
      connectedAgentId: "rev1",
    });
    mount({ path: "/agents/rev1" });

    act(() =>
      (propsOf("AgentListContent").openSubmittedReview as (a: Agent) => void)(
        reviewer
      )
    );

    expect(locationHref()).toBe("/agents/rev1");
    expect(H.state.setExpandedAgentId).not.toHaveBeenCalled();
    expect(H.state.setMediaOpen).not.toHaveBeenCalled();
  });

  it("ignores a review agent with no parent to jump back to", () => {
    const orphan = makeAgent({
      id: "rev1",
      parentAgentId: null,
      submittedReviewId: 9,
    });
    Object.assign(H.state, {
      agents: [orphan],
      validatedSelectedAgentId: "rev1",
      connState: "connected",
      connectedAgentId: "rev1",
    });
    mount({ path: "/agents/rev1" });

    act(() =>
      (propsOf("AgentListContent").openSubmittedReview as (a: Agent) => void)(
        orphan
      )
    );

    expect(locationHref()).toBe("/agents/rev1");
    expect(H.state.setMediaActiveTab).not.toHaveBeenCalled();
  });
});

describe("AgentsView media sidebar", () => {
  it("opens the sidebar when the focused agent starts streaming", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1", hasStream: false })],
      validatedSelectedAgentId: "a1",
      connState: "connected",
      connectedAgentId: "a1",
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
      connState: "connected",
      connectedAgentId: "a1",
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

  it("marks messages read only while the panel is open on the messages tab", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
      connState: "connected",
      connectedAgentId: "a1",
      mediaPanelOpen: true,
      mediaActiveTab: "media",
    });
    mount();
    expect(H.state.markMessagesRead).not.toHaveBeenCalled();

    cleanup();
    H.clearProps();
    H.state.mediaActiveTab = "messages";
    mount();
    expect(H.state.markMessagesRead).toHaveBeenCalled();

    cleanup();
    H.clearProps();
    (H.state.markMessagesRead as ReturnType<typeof vi.fn>).mockClear();
    H.state.mediaPanelOpen = false;
    mount();
    expect(H.state.markMessagesRead).not.toHaveBeenCalled();
  });
});

describe("AgentsView terminal attachment", () => {
  it("auto-attaches to the agent named in the route, taking over the terminal", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
      connState: "disconnected",
      connectedAgentId: null,
    });
    mount();

    // Both flags matter: the first forces the attach even though the terminal
    // is idle, the second lets it take over a session already attached
    // elsewhere. A deep-link that only "connects if free" silently no-ops.
    expect(H.state.ensureTerminalConnected).toHaveBeenCalledWith(
      true,
      true,
      "a1"
    );
  });

  it("does not re-attach to the agent it is already connected to", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
      connState: "connected",
      connectedAgentId: "a1",
    });
    mount();

    expect(H.state.ensureTerminalConnected).not.toHaveBeenCalled();
  });

  it("detaches when the route leaves the agents list with a terminal attached", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: null,
      connState: "connected",
      connectedAgentId: "a1",
    });
    mount({ path: "/agents" });

    expect(H.state.detachTerminal).toHaveBeenCalled();
  });

  it("does not detach when the route has no agent and nothing is attached", () => {
    Object.assign(H.state, {
      agents: [],
      validatedSelectedAgentId: null,
      connState: "disconnected",
      connectedAgentId: null,
    });
    mount({ path: "/agents" });

    expect(H.state.detachTerminal).not.toHaveBeenCalled();
  });

  it("keeps the terminal attached while the route still names an agent", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
      connState: "connected",
      connectedAgentId: "a1",
    });
    mount();

    expect(H.state.detachTerminal).not.toHaveBeenCalled();
  });

  it("refocuses the terminal shortly after a side panel closes", () => {
    vi.useFakeTimers();
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
      connState: "connected",
      connectedAgentId: "a1",
    });
    const { rerender, props } = mount({ leftPanelOpen: true });
    expect(H.state.focusTerminal).not.toHaveBeenCalled();

    const closedProps = { ...props, leftPanelOpen: false };
    rerender(tree("/agents/a1", closedProps));
    // The refocus is deferred so it lands after the panel's width transition
    // has released the terminal's space.
    expect(H.state.focusTerminal).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(H.state.focusTerminal).toHaveBeenCalledTimes(1);
  });

  it("reports the archive phase only for an agent that is archiving", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
      connState: "connected",
      connectedAgentId: "a1",
      selectedAgent: makeAgent({
        id: "a1",
        status: "running",
        archivePhase: "finalizing",
      }),
    });
    mount();
    // The pane is portalled out of the React tree, so confirm it really landed
    // in the shared container before reading the props it recorded.
    expect(
      terminalContainer().querySelector("[data-testid='stub-TerminalPane']")
    ).not.toBeNull();
    expect(propsOf("TerminalPane").archivePhase).toBeNull();

    cleanup();
    H.clearProps();
    H.state.selectedAgent = makeAgent({
      id: "a1",
      status: "archiving",
      archivePhase: "worktree-cleanup",
    });
    mount();
    expect(propsOf("TerminalPane").archivePhase).toBe("worktree-cleanup");
  });
});

describe("AgentsView center pane", () => {
  it("renders the changes pane from the split layout without a changes route", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
      connState: "connected",
      connectedAgentId: "a1",
      isSplit: true,
      splitState: { left: "terminal", right: "changes" },
    });
    mount({ path: "/agents/a1" });

    expect(renderedChildren()).toContain("ChangesTab");
    // The whiteboard is checked at the source, not in the DOM: the split's
    // slots decide what mounts, so an element built from a stale match would
    // be absent from the document either way.
    expect(propsOf("CenterPaneSplit").whiteboardElement).toBeNull();
  });

  it("renders the changes pane from the split layout's left slot", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
      connState: "connected",
      connectedAgentId: "a1",
      isSplit: true,
      splitState: { left: "changes", right: "terminal" },
    });
    mount({ path: "/agents/a1" });

    expect(renderedChildren()).toContain("ChangesTab");
    expect(propsOf("ChangesTab").agentId).toBe("a1");
  });

  it("renders the whiteboard from the split layout's left slot", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
      connState: "connected",
      connectedAgentId: "a1",
      isSplit: true,
      splitState: { left: "whiteboard", right: "terminal" },
    });
    mount({ path: "/agents/a1" });

    expect(renderedChildren()).toContain("WhiteboardPane");
    expect(propsOf("CenterPaneSplit").changesElement).toBeNull();
  });

  it("ignores the route matches while split, so a stale route cannot double-render", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
      connState: "connected",
      connectedAgentId: "a1",
      isSplit: true,
      splitState: { left: "terminal", right: "terminal" },
      changesMatch: true,
      whiteboardMatch: true,
    });
    mount({ path: "/agents/a1/changes" });

    expect(renderedChildren()).not.toContain("ChangesTab");
    expect(renderedChildren()).not.toContain("WhiteboardPane");
    // The split's own slots decide what is mounted, so the panes have to be
    // absent at the source: a pane built from a stale route match would be
    // handed to the split and appear the moment a slot switched to it.
    expect(propsOf("CenterPaneSplit").changesElement).toBeNull();
    expect(propsOf("CenterPaneSplit").whiteboardElement).toBeNull();
  });

  it("renders the whiteboard inline when its route matches and nothing is split", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
      connState: "connected",
      connectedAgentId: "a1",
      whiteboardMatch: true,
    });
    mount({ path: "/agents/a1/whiteboard" });

    expect(renderedChildren()).toContain("WhiteboardPane");
    expect(propsOf("WhiteboardPane").agentId).toBe("a1");
    expect(renderedChildren()).not.toContain("CenterPaneSplit");
  });
});

describe("AgentsView dialogs", () => {
  it("resolves the create dialog's cwd from the selected agent first", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a3", cwd: "/repos/newest" })],
      validatedSelectedAgentId: "a1",
      selectedAgent: makeAgent({ id: "a1", cwd: "/repos/selected" }),
      connectedAgent: makeAgent({ id: "a2", cwd: "/repos/connected" }),
    });
    mount();

    const resolve = propsOf("AgentsViewDialogs")
      .resolveCreateDefaultCwd as () => string;
    expect(resolve()).toBe("/repos/selected");
  });

  it("falls back to the connected agent, then the newest one, then nothing", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a3", cwd: "/repos/newest" })],
      validatedSelectedAgentId: null,
      selectedAgent: null,
      connectedAgent: makeAgent({ id: "a2", cwd: "/repos/connected" }),
    });
    mount({ path: "/agents" });
    expect(
      (propsOf("AgentsViewDialogs").resolveCreateDefaultCwd as () => string)()
    ).toBe("/repos/connected");

    cleanup();
    H.clearProps();
    H.state.connectedAgent = null;
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
  it("mounts the mobile toolbar and reports it connected only when attached", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
      connState: "reconnecting",
      connectedAgentId: "a1",
    });
    mount({ isMobile: true });

    expect(renderedChildren()).toContain("MobileTerminalToolbar");
    expect(propsOf("MobileTerminalToolbar").isConnected).toBe(false);
    // The copy-mode banner and bottom bar are desktop-only chrome.
    expect(renderedChildren()).not.toContain("TerminalCopyModeBannerLayer");
    expect(renderedChildren()).not.toContain("BottomBar");
  });

  it("mounts the desktop chrome and no mobile toolbar on a wide screen", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
      connState: "connected",
      connectedAgentId: "a1",
    });
    mount({ isMobile: false });

    expect(renderedChildren()).toContain("BottomBar");
    expect(renderedChildren()).toContain("TerminalCopyModeBannerLayer");
    expect(renderedChildren()).not.toContain("MobileTerminalToolbar");
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
  it("feeds the live connection back into the agents list", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" }), makeAgent({ id: "a2" })],
      validatedSelectedAgentId: "a1",
      connState: "connected",
      connectedAgentId: "a2",
    });
    mount();

    // useAgents sorts and validates against what the terminal is actually
    // attached to, so a stale or hard-coded state here reorders the sidebar
    // and can invalidate the selection.
    expect(hookArgs("useAgents").sharedConnectedAgentId).toBe("a2");
    expect(hookArgs("useAgents").sharedConnState).toBe("connected");
    expect(hookArgs("useAgents").routeAgentId).toBe("a1");
  });

  it("re-sorts the list when the terminal attaches somewhere new", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
      connState: "connected",
      connectedAgentId: "a1",
    });
    mount();

    expect(H.state.resortAgents).toHaveBeenCalled();
  });

  it("keys the media sidebar off the attached agent, not the selected one", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" }), makeAgent({ id: "a2" })],
      validatedSelectedAgentId: "a1",
      connState: "connected",
      connectedAgentId: "a2",
    });
    mount();

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

  it("marks messages read for the focused agent, not the selected one", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" }), makeAgent({ id: "a2" })],
      validatedSelectedAgentId: "a1",
      connState: "connected",
      connectedAgentId: "a2",
    });
    mount();

    expect(hookArgs("useMarkMessagesRead").agentId).toBe("a2");
  });

  it("offers the focus-terminal hotkey only for a tmux agent in focus", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
      connState: "connected",
      connectedAgentId: "a1",
    });
    mount();
    expect(hookArgs("useAgentHotkeys").canFocusTerminal).toBe(true);

    cleanup();
    H.clearProps();
    H.state.terminalMode = "none";
    mount();
    expect(hookArgs("useAgentHotkeys").canFocusTerminal).toBe(false);

    cleanup();
    H.clearProps();
    H.state.terminalMode = "tmux";
    H.state.connState = "disconnected";
    mount();
    expect(hookArgs("useAgentHotkeys").canFocusTerminal).toBe(false);
  });

  it("reads the whiteboard hint for the focused agent", () => {
    const store = getDefaultStore();
    store.set(whiteboardAgentDrewAtomFamily("a2"), true);
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" }), makeAgent({ id: "a2" })],
      validatedSelectedAgentId: "a1",
      connState: "connected",
      connectedAgentId: "a2",
    });
    mount();

    expect(propsOf("AgentsViewHeader").whiteboardAgentDrew).toBe(true);
    store.set(whiteboardAgentDrewAtomFamily("a2"), false);
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

  it("closes the mobile media sidebar after one of its shortcuts runs", () => {
    Object.assign(H.state, {
      agents: [makeAgent({ id: "a1" })],
      validatedSelectedAgentId: "a1",
      connState: "connected",
      connectedAgentId: "a1",
    });
    const { props } = mount({ isMobile: true });

    act(() => (propsOf("MediaSidebarContent").onShortcutRun as () => void)());

    expect(props.setMobileMediaOpen).toHaveBeenCalledWith(false);
  });
});
