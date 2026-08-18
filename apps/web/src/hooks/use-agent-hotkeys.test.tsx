// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import type { Location } from "react-router-dom";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";
import type { UseHotkeyOptions } from "@/lib/hotkeys/use-hotkey";
import type { Template } from "@/hooks/use-templates";

import { useAgentHotkeys } from "./use-agent-hotkeys";

// Registry of the latest handler + options registered per hotkey id. useHotkey
// is called on every render, so each entry always reflects the most recent
// render's closure — invoking a handler after a rerender sees fresh props.
// Entries survive unmount (no effect cleanup in the mock) — clear the map
// manually when mounting a second hook instance within one test.
type Registered = {
  handler: (e: KeyboardEvent) => void;
  options: UseHotkeyOptions;
};
const registeredHotkeys = new Map<string, Registered>();

vi.mock("@/lib/hotkeys/use-hotkey", () => ({
  useHotkey: (
    id: string,
    handler: (e: KeyboardEvent) => void,
    options: UseHotkeyOptions = {}
  ) => {
    registeredHotkeys.set(id, { handler, options });
  },
}));

const useTemplatesMock = vi.fn<() => { data?: Template[] }>();
vi.mock("@/hooks/use-templates", () => ({
  useTemplates: () => useTemplatesMock(),
}));

function pressHotkey(
  id: string,
  { bypassEnabled = false }: { bypassEnabled?: boolean } = {}
): void {
  const entry = registeredHotkeys.get(id);
  if (!entry) throw new Error(`hotkey ${id} was never registered`);
  // Production never invokes a disabled hotkey's handler — refuse to fire it
  // so a test can't green-light unreachable behavior. bypassEnabled exists
  // solely to exercise a handler's own internal guard.
  if (entry.options.enabled === false && !bypassEnabled) {
    throw new Error(`hotkey ${id} is disabled; pass bypassEnabled to force`);
  }
  act(() => entry.handler(new KeyboardEvent("keydown")));
}

function hotkeyOptions(id: string): UseHotkeyOptions {
  const entry = registeredHotkeys.get(id);
  if (!entry) throw new Error(`hotkey ${id} was never registered`);
  return entry.options;
}

function makeAgent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id,
    status: "running",
    cwd: "/repo",
    worktreePath: null,
    worktreeBranch: null,
    tmuxSession: null,
    agentArgs: [],
    fullAccess: false,
    mediaDir: null,
    ...overrides,
  } as Agent;
}

// A sub agent: any agent whose parent is also in the list, review or not.
function makeReviewAgent(id: string, parentAgentId: string): Agent {
  return makeAgent(id, { parentAgentId, role: "review" });
}

function makeTemplate(id: string, name: string, callable: boolean): Template {
  return { id, name, callable } as Template;
}

type HookArgs = Parameters<typeof useAgentHotkeys>[0];

function defaultArgs(overrides: Partial<HookArgs> = {}): HookArgs {
  return {
    agents: [],
    isMobile: false,
    sidebarAgentId: null,
    validatedSelectedAgentId: null,
    canFocusTerminal: false,
    focusTerminal: vi.fn(),
    mediaOpen: false,
    setMediaOpen: vi.fn(),
    leftPanelOpen: true,
    handleSetLeftPanelOpen: vi.fn(),
    openCreateDialog: vi.fn(),
    ...overrides,
  };
}

function renderAgentHotkeys(initialProps: HookArgs) {
  const locationRef: { current: Location | null } = { current: null };

  function LocationProbe() {
    locationRef.current = useLocation();
    return null;
  }

  const utils = renderHook((props: HookArgs) => useAgentHotkeys(props), {
    initialProps,
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={["/agents"]}>
        {children}
        <LocationProbe />
      </MemoryRouter>
    ),
  });

  return {
    ...utils,
    pathname: () => {
      const location = locationRef.current;
      if (!location) throw new Error("location probe never rendered");
      return location.pathname;
    },
  };
}

beforeEach(() => {
  useTemplatesMock.mockReturnValue({ data: [] });
});

afterEach(() => {
  cleanup();
  registeredHotkeys.clear();
  useTemplatesMock.mockReset();
});

describe("useAgentHotkeys", () => {
  describe("agent cycling", () => {
    const a1 = makeAgent("agt_1");
    const a2 = makeAgent("agt_2");
    const a3 = makeAgent("agt_3");
    const review = makeReviewAgent("agt_review", "agt_2");

    it("advances to the next agent and wraps at the end", () => {
      const { pathname, rerender } = renderAgentHotkeys(
        defaultArgs({
          agents: [a1, a2, a3],
          validatedSelectedAgentId: "agt_2",
        })
      );

      pressHotkey("focus-next-agent");
      expect(pathname()).toBe("/agents/agt_3");

      rerender(
        defaultArgs({
          agents: [a1, a2, a3],
          validatedSelectedAgentId: "agt_3",
        })
      );
      pressHotkey("focus-next-agent");
      expect(pathname()).toBe("/agents/agt_1");
    });

    it("goes to the previous agent and wraps at the start", () => {
      const { pathname, rerender } = renderAgentHotkeys(
        defaultArgs({
          agents: [a1, a2, a3],
          validatedSelectedAgentId: "agt_2",
        })
      );

      pressHotkey("focus-prev-agent");
      expect(pathname()).toBe("/agents/agt_1");

      rerender(
        defaultArgs({
          agents: [a1, a2, a3],
          validatedSelectedAgentId: "agt_1",
        })
      );
      pressHotkey("focus-prev-agent");
      expect(pathname()).toBe("/agents/agt_3");
    });

    it("skips nested review agents when cycling", () => {
      const { pathname } = renderAgentHotkeys(
        defaultArgs({
          agents: [a1, review, a2],
          validatedSelectedAgentId: "agt_1",
        })
      );

      pressHotkey("focus-next-agent");
      expect(pathname()).toBe("/agents/agt_2");
    });

    it("indexes into the filtered list when a review agent precedes the selection", () => {
      // With the review agent first, the selected agent's index differs
      // between the raw list (1) and the filtered list (0) — cycling must
      // use the filtered index or it lands on the wrong neighbor.
      const { pathname } = renderAgentHotkeys(
        defaultArgs({
          agents: [review, a1, a2],
          validatedSelectedAgentId: "agt_1",
        })
      );

      pressHotkey("focus-next-agent");
      expect(pathname()).toBe("/agents/agt_2");
    });

    it("cycles a selected review agent relative to its parent card", () => {
      // The review agent has no card of its own, but it is reachable only from
      // inside agt_2's card — so next means "the card after agt_2", not "start
      // over at the first card", which is where the index lookup used to land.
      const { pathname } = renderAgentHotkeys(
        defaultArgs({
          agents: [a1, a2, review, a3],
          validatedSelectedAgentId: "agt_review",
        })
      );

      pressHotkey("focus-next-agent");
      expect(pathname()).toBe("/agents/agt_3");
    });

    it("with no selection, next goes to the first agent and prev to the last", () => {
      const first = renderAgentHotkeys(
        defaultArgs({ agents: [a1, a2, a3], validatedSelectedAgentId: null })
      );
      pressHotkey("focus-next-agent");
      expect(first.pathname()).toBe("/agents/agt_1");
      first.unmount();
      registeredHotkeys.clear();

      const second = renderAgentHotkeys(
        defaultArgs({ agents: [a1, a2, a3], validatedSelectedAgentId: null })
      );
      pressHotkey("focus-prev-agent");
      expect(second.pathname()).toBe("/agents/agt_3");
    });

    it("does not navigate when every agent is a sub agent", () => {
      const { pathname } = renderAgentHotkeys(
        defaultArgs({
          agents: [a2, review],
          validatedSelectedAgentId: "agt_2",
        })
      );

      pressHotkey("focus-next-agent");
      expect(pathname()).toBe("/agents/agt_2");
      pressHotkey("focus-prev-agent");
      expect(pathname()).toBe("/agents/agt_2");
    });

    it("skips plain children, not just review agents", () => {
      // The sidebar renders every child inside its parent's card, so cycling
      // must skip a child launched by dispatch_launch_agent too.
      const plainChild = makeAgent("agt_plain_child", {
        parentAgentId: "agt_1",
      });
      const { pathname } = renderAgentHotkeys(
        defaultArgs({
          agents: [a1, plainChild, a3],
          validatedSelectedAgentId: "agt_1",
        })
      );

      pressHotkey("focus-next-agent");
      expect(pathname()).toBe("/agents/agt_3");
    });

    it("cycles relative to the card a selected sub agent lives in", () => {
      // Selecting a sub agent used to leave the index at -1, so next jumped to
      // the first card instead of stepping past the card holding it.
      const child = makeAgent("agt_child_of_2", { parentAgentId: "agt_2" });
      const { pathname } = renderAgentHotkeys(
        defaultArgs({
          agents: [a1, a2, child, a3],
          validatedSelectedAgentId: "agt_child_of_2",
        })
      );

      pressHotkey("focus-next-agent");
      expect(pathname()).toBe("/agents/agt_3");
    });

    it("steps backwards from a selected sub agent's card too", () => {
      const child = makeAgent("agt_child_of_2", { parentAgentId: "agt_2" });
      const { pathname } = renderAgentHotkeys(
        defaultArgs({
          agents: [a1, a2, child, a3],
          validatedSelectedAgentId: "agt_child_of_2",
        })
      );

      pressHotkey("focus-prev-agent");
      expect(pathname()).toBe("/agents/agt_1");
    });

    it("cycles an orphaned child whose parent is gone", () => {
      // Only review children cascade on archive, so a plain child outlives its
      // parent. It gets its own card, and must stay reachable.
      const orphan = makeAgent("agt_orphan", { parentAgentId: "agt_missing" });
      const { pathname } = renderAgentHotkeys(
        defaultArgs({
          agents: [a1, orphan],
          validatedSelectedAgentId: "agt_1",
        })
      );

      pressHotkey("focus-next-agent");
      expect(pathname()).toBe("/agents/agt_orphan");
    });

    it("treats an agent with role=review but no parent as cycleable", () => {
      // isNestedReviewAgent requires BOTH parentAgentId and role="review";
      // a top-level review-role agent stays in the cycle order.
      const topLevelReview = makeAgent("agt_toprev", { role: "review" });
      const { pathname } = renderAgentHotkeys(
        defaultArgs({
          agents: [a1, topLevelReview],
          validatedSelectedAgentId: "agt_1",
        })
      );

      pressHotkey("focus-next-agent");
      expect(pathname()).toBe("/agents/agt_toprev");
    });
  });

  describe("focus-terminal-input", () => {
    it("registers enabled and calls focusTerminal on desktop when focusable", () => {
      const focusTerminal = vi.fn();
      renderAgentHotkeys(
        defaultArgs({ isMobile: false, canFocusTerminal: true, focusTerminal })
      );

      expect(hotkeyOptions("focus-terminal-input").enabled).toBe(true);
      pressHotkey("focus-terminal-input");
      expect(focusTerminal).toHaveBeenCalledTimes(1);
    });

    it("registers disabled on mobile even when the terminal is focusable", () => {
      renderAgentHotkeys(
        defaultArgs({ isMobile: true, canFocusTerminal: true })
      );
      expect(hotkeyOptions("focus-terminal-input").enabled).toBe(false);
    });

    it("registers disabled and guards the handler when the terminal is not focusable", () => {
      const focusTerminal = vi.fn();
      renderAgentHotkeys(
        defaultArgs({ isMobile: false, canFocusTerminal: false, focusTerminal })
      );

      expect(hotkeyOptions("focus-terminal-input").enabled).toBe(false);
      // The handler itself also guards, independent of the enabled option.
      pressHotkey("focus-terminal-input", { bypassEnabled: true });
      expect(focusTerminal).not.toHaveBeenCalled();
    });
  });

  describe("toggle-media-sidebar", () => {
    it("is a no-op on desktop with no sidebar agent", () => {
      const setMediaOpen = vi.fn();
      renderAgentHotkeys(
        defaultArgs({ isMobile: false, sidebarAgentId: null, setMediaOpen })
      );

      pressHotkey("toggle-media-sidebar");
      expect(setMediaOpen).not.toHaveBeenCalled();
    });

    it("toggles on desktop when a sidebar agent is present", () => {
      const setMediaOpen = vi.fn();
      renderAgentHotkeys(
        defaultArgs({
          isMobile: false,
          sidebarAgentId: "agt_1",
          mediaOpen: false,
          setMediaOpen,
        })
      );

      pressHotkey("toggle-media-sidebar");
      expect(setMediaOpen).toHaveBeenCalledTimes(1);
      expect(setMediaOpen).toHaveBeenCalledWith(true);
    });

    it("toggles closed on mobile even without a sidebar agent", () => {
      const setMediaOpen = vi.fn();
      renderAgentHotkeys(
        defaultArgs({
          isMobile: true,
          sidebarAgentId: null,
          mediaOpen: true,
          setMediaOpen,
        })
      );

      pressHotkey("toggle-media-sidebar");
      expect(setMediaOpen).toHaveBeenCalledTimes(1);
      expect(setMediaOpen).toHaveBeenCalledWith(false);
    });
  });

  describe("toggle-agent-sidebar", () => {
    it("inverts the current left panel state", () => {
      const handleSetLeftPanelOpen = vi.fn();
      const { rerender } = renderAgentHotkeys(
        defaultArgs({ leftPanelOpen: true, handleSetLeftPanelOpen })
      );

      pressHotkey("toggle-agent-sidebar");
      expect(handleSetLeftPanelOpen).toHaveBeenCalledWith(false);

      rerender(defaultArgs({ leftPanelOpen: false, handleSetLeftPanelOpen }));
      pressHotkey("toggle-agent-sidebar");
      expect(handleSetLeftPanelOpen).toHaveBeenLastCalledWith(true);
    });
  });

  describe("command palette", () => {
    it("open-command-palette toggles paletteOpen", () => {
      const { result } = renderAgentHotkeys(defaultArgs());
      expect(result.current.paletteOpen).toBe(false);

      pressHotkey("open-command-palette");
      expect(result.current.paletteOpen).toBe(true);

      pressHotkey("open-command-palette");
      expect(result.current.paletteOpen).toBe(false);
    });

    it("new-agent action opens the create dialog", () => {
      const openCreateDialog = vi.fn();
      const { result } = renderAgentHotkeys(defaultArgs({ openCreateDialog }));

      const newAgent = result.current.paletteActions.find(
        (a) => a.id === "new-agent"
      );
      expect(newAgent).toBeDefined();
      act(() => newAgent!.run());
      expect(openCreateDialog).toHaveBeenCalledTimes(1);
    });

    it("keyboard-shortcuts action navigates to the shortcuts help page", () => {
      const { result, pathname } = renderAgentHotkeys(defaultArgs());

      const shortcuts = result.current.paletteActions.find(
        (a) => a.id === "keyboard-shortcuts"
      );
      expect(shortcuts).toBeDefined();
      act(() => shortcuts!.run());
      expect(pathname()).toBe("/settings/help/shortcuts");
    });
  });

  describe("template palette groups", () => {
    it("returns no groups when no templates are callable", () => {
      useTemplatesMock.mockReturnValue({
        data: [makeTemplate("t1", "Deploy", false)],
      });
      const { result } = renderAgentHotkeys(defaultArgs());
      expect(result.current.paletteGroups).toEqual([]);
    });

    it("returns no groups when the templates query has no data yet", () => {
      useTemplatesMock.mockReturnValue({});
      const { result } = renderAgentHotkeys(defaultArgs());
      expect(result.current.paletteGroups).toEqual([]);
    });

    it("maps only callable templates into the Templates group", () => {
      useTemplatesMock.mockReturnValue({
        data: [
          makeTemplate("t1", "Deploy", true),
          makeTemplate("t2", "Not callable", false),
          makeTemplate("t3", "Review", true),
        ],
      });
      const { result } = renderAgentHotkeys(defaultArgs());

      expect(result.current.paletteGroups).toHaveLength(1);
      const group = result.current.paletteGroups[0];
      expect(group.label).toBe("Templates");
      expect(group.actions.map((a) => ({ id: a.id, title: a.title }))).toEqual([
        { id: "template-t1", title: "Deploy" },
        { id: "template-t3", title: "Review" },
      ]);
    });

    it("running a template action closes the palette and resolves launchTemplate", () => {
      const deploy = makeTemplate("t1", "Deploy", true);
      useTemplatesMock.mockReturnValue({ data: [deploy] });
      const { result } = renderAgentHotkeys(defaultArgs());

      pressHotkey("open-command-palette");
      expect(result.current.paletteOpen).toBe(true);
      expect(result.current.launchTemplate).toBeNull();

      act(() => result.current.paletteGroups[0].actions[0].run());

      expect(result.current.paletteOpen).toBe(false);
      expect(result.current.launchTemplate).toBe(deploy);
    });

    it("clearing the launch template id resets launchTemplate to null", () => {
      const deploy = makeTemplate("t1", "Deploy", true);
      useTemplatesMock.mockReturnValue({ data: [deploy] });
      const { result } = renderAgentHotkeys(defaultArgs());

      act(() => result.current.setLaunchTemplateId("t1"));
      expect(result.current.launchTemplate).toBe(deploy);

      act(() => result.current.setLaunchTemplateId(null));
      expect(result.current.launchTemplate).toBeNull();
    });

    it("launchTemplate is null when the id no longer matches any template", () => {
      useTemplatesMock.mockReturnValue({
        data: [makeTemplate("t1", "Deploy", true)],
      });
      const { result } = renderAgentHotkeys(defaultArgs());

      act(() => result.current.setLaunchTemplateId("t_gone"));
      expect(result.current.launchTemplate).toBeNull();
    });
  });
});
