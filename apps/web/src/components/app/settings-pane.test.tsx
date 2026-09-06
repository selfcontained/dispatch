// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Settings } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SettingsSection } from "./settings-state";
import { SettingsContent, SettingsNavContent } from "./settings-pane";

// Every settings panel this file routes to is replaced by a marker that records
// the props it was handed. The module under test is a routing table and a
// wiring harness, not a panel — each panel has its own suite, and `tsc` already
// keeps the prop *shapes* honest. What tsc cannot catch is two same-typed props
// handed to the wrong child, which is what the wiring assertions are for.
const { stubModule, lastProps, clearProps } = vi.hoisted(() => {
  const props = new Map<string, Record<string, unknown>>();
  const stubModule = (exportName: string) => async () => {
    const React = await import("react");
    return {
      [exportName]: (received: Record<string, unknown>) => {
        props.set(exportName, received);
        return React.createElement("div", {
          "data-testid": `stub-${exportName}`,
        });
      },
    };
  };
  return {
    stubModule,
    lastProps: (exportName: string) => props.get(exportName),
    // Cleared between tests: a panel that never mounted must read as absent
    // rather than handing back whatever the previous test recorded.
    clearProps: () => props.clear(),
  };
});

vi.mock(
  "@/components/app/agent-type-settings",
  stubModule("AgentTypeSettings")
);
vi.mock(
  "@/components/app/appearance-settings",
  stubModule("AppearanceSettings")
);
vi.mock(
  "@/components/app/browser-extension-settings",
  stubModule("BrowserExtensionSettings")
);
vi.mock(
  "@/components/app/chat-surface-settings",
  stubModule("ChatSurfaceSettings")
);
vi.mock(
  "@/components/app/cross-repo-messaging-settings",
  stubModule("CrossRepoMessagingSettings")
);
vi.mock(
  "@/components/app/injection-hold-settings",
  stubModule("InjectionHoldSettings")
);
vi.mock(
  "@/components/app/launch-guidance-settings",
  stubModule("LaunchGuidanceSettings")
);
vi.mock(
  "@/components/app/plugin-update-settings",
  stubModule("PluginUpdateSettings")
);
vi.mock("@/components/app/ide-settings", stubModule("IdeSettings"));
vi.mock(
  "@/components/app/instance-name-settings",
  stubModule("InstanceNameSettings")
);
vi.mock(
  "@/components/app/notification-settings",
  stubModule("NotificationSettings")
);
vi.mock(
  "@/components/app/personality-settings",
  stubModule("PersonalitySettings")
);
vi.mock("@/components/app/release-admin", stubModule("ReleasesAdmin"));
vi.mock("@/components/app/updates-section", stubModule("UpdatesSection"));
vi.mock("@/components/app/security-settings", stubModule("SecuritySettings"));
vi.mock(
  "@/components/app/service-resources-settings",
  stubModule("ServiceResourcesSettings")
);
vi.mock(
  "@/components/app/worktree-location-settings",
  stubModule("WorktreeLocationSettings")
);
vi.mock(
  "@/components/app/usage-budget-settings",
  stubModule("UsageBudgetSettings")
);

// The docs nav list is real data the sidebar renders one entry per, so only the
// heavy content pane is stubbed out.
vi.mock("@/components/app/docs-pane", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/app/docs-pane")>();
  const stub = await stubModule("DocsContent")();
  return { DOCS_SECTION_NAV: actual.DOCS_SECTION_NAV, ...stub };
});

// The release stream is owned by SettingsContent so an in-flight update's
// client-side restart poll survives navigating away from the Updates tab. The
// fake hands back one identity per hook *instance*, so a stream that is torn
// down and rebuilt on navigation is visible to the assertions below.
vi.mock("@/hooks/use-release-stream", async () => {
  const React = await import("react");
  let seq = 0;
  return {
    useReleaseStream: vi.fn((kind: string) => {
      const [stream] = React.useState(() => ({ kind, instance: ++seq }));
      return stream;
    }),
  };
});

const { DOCS_SECTION_NAV } = await import("@/components/app/docs-pane");
const { useReleaseStream } = await import("@/hooks/use-release-stream");
const releaseStreamMock = vi.mocked(useReleaseStream);

type NavProps = Parameters<typeof SettingsNavContent>[0];
type ContentProps = Parameters<typeof SettingsContent>[0];

const SECTIONS: NavProps["sections"] = [
  // Labels deliberately avoid every DOCS_SECTION_NAV label ("Agents",
  // "Updates", "Notifications", ...) so a docs sub-entry and a section button
  // can never be mistaken for one another by a text query.
  { id: "general", label: "General", icon: Settings },
  { id: "agents", label: "Agent setup", icon: Settings },
  { id: "updates", label: "Software updates", icon: Settings },
  { id: "releases", label: "Release admin", icon: Settings },
  { id: "help", label: "Help", icon: Settings },
];

function renderNav(overrides: Partial<NavProps> = {}) {
  const props: NavProps = {
    activeSection: "general",
    sections: SECTIONS,
    onSectionChange: vi.fn(),
    onSubsectionChange: vi.fn(),
    // Deliberately different states: with API and DB set to the same one,
    // every assertion below would pass against either source.
    apiState: "ok",
    dbState: "down",
    serviceDotClass: (state) => `dot-for-${state}`,
    ...overrides,
  };
  render(<SettingsNavContent {...props} />);
  return props;
}

function renderContent(overrides: Partial<ContentProps> = {}) {
  const props: ContentProps = {
    activeSection: "general",
    onLogout: vi.fn(),
    theme: "cool-navy",
    setTheme: vi.fn(),
    iconColor: "blue",
    setIconColor: vi.fn(),
    isIconColorSaving: false,
    iconColorError: null,
    clearIconColorError: vi.fn(),
    enabledAgentTypes: ["claude"],
    onEnabledAgentTypesChange: vi.fn(),
    enabledIdes: ["vscode"],
    onEnabledIdesChange: vi.fn(),
    onSubsectionChange: vi.fn(),
    isAdmin: false,
    ...overrides,
  };
  const view = render(<SettingsContent {...props} />);
  return { ...view, props };
}

/** Names of the stubbed panels currently mounted, in document order. */
function renderedPanels(): string[] {
  return Array.from(document.querySelectorAll("[data-testid^='stub-']")).map(
    (el) => el.getAttribute("data-testid")!.replace("stub-", "")
  );
}

beforeEach(() => {
  clearProps();
  releaseStreamMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("SettingsNavContent", () => {
  it("lists the sections it is given, in order", () => {
    renderNav();

    const labels = Array.from(
      screen.getByRole("navigation").querySelectorAll("button")
    ).map((b) => b.textContent);
    expect(labels).toEqual([
      "General",
      "Agent setup",
      "Software updates",
      "Release admin",
      "Help",
    ]);
  });

  it("reports the section the operator picked", () => {
    const { onSectionChange } = renderNav();

    fireEvent.click(screen.getByRole("button", { name: "Software updates" }));

    expect(onSectionChange).toHaveBeenCalledWith("updates");
  });

  it("marks only the active section", () => {
    renderNav({ activeSection: "agents" });

    expect(
      screen.getByRole("button", { name: "Agent setup" }).className
    ).toContain("bg-primary/10");
    expect(
      screen.getByRole("button", { name: "General" }).className
    ).not.toContain("bg-primary/10");
  });

  it("hides the docs sub-nav until Help is the active section", () => {
    renderNav({ activeSection: "general" });

    expect(screen.queryByText(DOCS_SECTION_NAV[0].label)).toBeNull();
  });

  it("hangs the docs sub-nav off Help alone, not off every section", () => {
    renderNav({ activeSection: "help" });

    // One copy, and it lives inside the Help entry: dropping the `id === "help"`
    // half of the guard repeats the whole docs list under all five sections.
    const entries = screen.getAllByText(DOCS_SECTION_NAV[0].label);
    expect(entries).toHaveLength(1);
    const help = screen.getByRole("button", { name: "Help" });
    expect(help.parentElement!.contains(entries[0])).toBe(true);
    expect(
      screen.getByRole("navigation").querySelectorAll("button")
    ).toHaveLength(SECTIONS.length + DOCS_SECTION_NAV.length);
  });

  it("reports the docs sub-section the operator picked", () => {
    const { onSubsectionChange } = renderNav({ activeSection: "help" });

    fireEvent.click(screen.getByText(DOCS_SECTION_NAV[1].label));

    expect(onSubsectionChange).toHaveBeenCalledWith(DOCS_SECTION_NAV[1].id);
  });

  it("colours the API and DB dots from their own service states", () => {
    renderNav();

    expect(screen.getByTestId("service-status-api").textContent).toContain(
      "ok"
    );
    expect(screen.getByTestId("service-status-db").textContent).toContain(
      "down"
    );
    expect(screen.getByTestId("service-dot-api").className).toContain(
      "dot-for-ok"
    );
    expect(screen.getByTestId("service-dot-db").className).toContain(
      "dot-for-down"
    );
  });
});

describe("SettingsContent", () => {
  it.each([
    [
      "general",
      ["InstanceNameSettings", "AppearanceSettings", "SecuritySettings"],
    ],
    [
      "agents",
      [
        "PersonalitySettings",
        "AgentTypeSettings",
        "IdeSettings",
        "LaunchGuidanceSettings",
        "PluginUpdateSettings",
        "InjectionHoldSettings",
        "CrossRepoMessagingSettings",
        "ChatSurfaceSettings",
        "UsageBudgetSettings",
        "WorktreeLocationSettings",
      ],
    ],
    ["notifications", ["NotificationSettings"]],
    ["connections", ["BrowserExtensionSettings"]],
    ["resources", ["ServiceResourcesSettings"]],
    ["updates", ["UpdatesSection"]],
    ["help", ["DocsContent"]],
  ] as Array<[SettingsSection, string[]]>)(
    "routes the %s section to its own panels, in order",
    (activeSection, expected) => {
      renderContent({ activeSection });

      expect(renderedPanels()).toEqual(expected);
    }
  );

  it("renders no panel at all when no section is active", () => {
    renderContent({ activeSection: null });

    expect(renderedPanels()).toEqual([]);
  });

  it("hands the logout action to the security panel, not the appearance one", () => {
    const { props } = renderContent({ activeSection: "general" });

    (lastProps("SecuritySettings")!.onLogout as () => void)();

    expect(props.onLogout).toHaveBeenCalledTimes(1);
    expect(props.clearIconColorError).not.toHaveBeenCalled();
  });

  it("hands the icon-colour reset and its error to the appearance panel", () => {
    const { props } = renderContent({
      activeSection: "general",
      iconColorError: "could not save",
      isIconColorSaving: true,
    });

    expect(lastProps("AppearanceSettings")!.iconColorError).toBe(
      "could not save"
    );
    expect(lastProps("AppearanceSettings")!.isIconColorSaving).toBe(true);
    (lastProps("AppearanceSettings")!.clearIconColorError as () => void)();

    expect(props.clearIconColorError).toHaveBeenCalledTimes(1);
    expect(props.onLogout).not.toHaveBeenCalled();
  });

  it("hands each enablement list to the panel that owns it", () => {
    const { props } = renderContent({ activeSection: "agents" });

    expect(lastProps("AgentTypeSettings")!.enabledAgentTypes).toEqual([
      "claude",
    ]);
    expect(lastProps("IdeSettings")!.enabledIdes).toEqual(["vscode"]);

    // Each panel's edits have to reach its own setter. Both round trips are
    // spelled out because the two `onChange` props are interchangeable at the
    // call site — only the list types differ, and a panel wired to a stray
    // closure instead of its setter still type-checks.
    (lastProps("AgentTypeSettings")!.onChange as (v: string[]) => void)([
      "codex",
    ]);
    (lastProps("IdeSettings")!.onChange as (v: string[]) => void)(["cursor"]);

    expect(props.onEnabledAgentTypesChange).toHaveBeenCalledWith(["codex"]);
    expect(props.onEnabledIdesChange).toHaveBeenCalledWith(["cursor"]);
  });

  it("subscribes to the update stream and hands it to the updates panel", () => {
    renderContent({ activeSection: "updates" });

    expect(releaseStreamMock).toHaveBeenCalledWith("update");
    expect(lastProps("UpdatesSection")!.stream).toBe(
      releaseStreamMock.mock.results[0]!.value
    );
  });

  it("subscribes to the update stream while another section is showing", () => {
    // The fixture is the teeth here: with General active the Updates panel is
    // unmounted, so the subscription can only come from this component. Moving
    // it down into UpdatesSection — where an in-flight update's restart poll
    // would die on every navigation — leaves nothing to call the hook.
    renderContent({ activeSection: "general" });

    expect(releaseStreamMock).toHaveBeenCalledWith("update");
  });

  it("keeps one update stream alive across a trip away from the Updates tab", () => {
    const { rerender, props } = renderContent({ activeSection: "updates" });
    const opened = lastProps("UpdatesSection")!.stream;
    expect(opened).toEqual({ kind: "update", instance: expect.any(Number) });

    rerender(<SettingsContent {...props} activeSection="general" />);
    rerender(<SettingsContent {...props} activeSection="updates" />);

    // The same object, not merely an equal one: a stream rebuilt on the way
    // back would have dropped an in-flight update's restart poll.
    expect(renderedPanels()).toEqual(["UpdatesSection"]);
    expect(lastProps("UpdatesSection")!.stream).toBe(opened);
  });

  it("opens the docs pane on the sub-section the route names", () => {
    const { props } = renderContent({
      activeSection: "help",
      initialSubsection: "worktrees",
    });

    expect(lastProps("DocsContent")!.initialSection).toBe("worktrees");
    expect(lastProps("DocsContent")!.title).toBe("Help & Docs");

    (lastProps("DocsContent")!.onSectionChange as (s: string) => void)(
      "personas"
    );

    expect(props.onSubsectionChange).toHaveBeenCalledWith("personas");
  });

  it("lets the docs pane own its height instead of scrolling as a page", () => {
    const { rerender, props } = renderContent({ activeSection: "help" });
    const docsScroller = screen.getByTestId("stub-DocsContent").parentElement!;

    expect(docsScroller.className).toContain("overflow-hidden");

    rerender(<SettingsContent {...props} activeSection="notifications" />);

    expect(
      screen.getByTestId("stub-NotificationSettings").parentElement!.className
    ).not.toContain("overflow-hidden");
  });

  it("starts each section at the top rather than inheriting the last scroll", () => {
    const { rerender, props } = renderContent({
      activeSection: "notifications",
    });
    screen.getByTestId("stub-NotificationSettings").parentElement!.scrollTop =
      500;

    rerender(<SettingsContent {...props} activeSection="connections" />);

    // The scroll container is keyed by section, so switching hands over a
    // fresh element; reusing it would carry the previous section's offset.
    expect(
      screen.getByTestId("stub-BrowserExtensionSettings").parentElement!
        .scrollTop
    ).toBe(0);
  });

  it("keeps the Releases admin panel away from non-admins", () => {
    renderContent({ activeSection: "releases", isAdmin: false });

    expect(renderedPanels()).toEqual([]);
  });

  it("shows the Releases admin panel to an admin", () => {
    renderContent({ activeSection: "releases", isAdmin: true });

    expect(renderedPanels()).toEqual(["ReleasesAdmin"]);
  });

  it("shows an admin no Releases panel outside the Releases section", () => {
    renderContent({ activeSection: "notifications", isAdmin: true });

    expect(renderedPanels()).toEqual(["NotificationSettings"]);
  });
});
