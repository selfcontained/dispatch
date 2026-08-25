// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigationType,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AutomationsRoute,
  ActivityRoute,
  SettingsRoute,
  serviceDotClass,
} from "./dashboard-sections";

// dashboard-sections.tsx is route-wiring, not markup: SectionShell owns the
// sidebar-open/close branching shared by every route, and the individual
// route components own navigation guards and the mobile-sidebar-close side
// effects. Every child it renders is replaced by a marker that records the
// props it received and (where the route drives a callback) exposes buttons
// to invoke them, so what's under test is the wiring dashboard-sections.tsx
// itself contributes.
const { H, record, stubModule } = vi.hoisted(() => {
  const props = new Map<string, Record<string, unknown>>();
  const record = (name: string, received: Record<string, unknown>) => {
    props.set(name, received);
  };
  const H = {
    props,
    clearProps: () => props.clear(),
    context: {} as Record<string, unknown>,
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
  return { H, record, stubModule };
});

vi.mock("@/components/app/agents-view", stubModule("AgentsView"));
vi.mock("@/components/app/activity-pane", stubModule("ActivityPane"));
vi.mock("@/components/app/design-lab", stubModule("DesignLab"));

vi.mock("@/components/app/dashboard-context", () => ({
  useDashboardContext: () => H.context,
}));

vi.mock("@/components/app/settings-state", () => ({
  useSettingsState: () => ({
    activeSection: "general",
    setActiveSectionState: vi.fn(),
    isAdmin: false,
    sections: [],
  }),
}));

vi.mock("@/components/app/automations-pane", async () => {
  const React = await import("react");
  return {
    AutomationsSidebarContent: (received: Record<string, unknown>) => {
      record("AutomationsSidebarContent", received);
      return React.createElement(
        "button",
        {
          "data-testid": "close-automations-sidebar",
          onClick: () => (received.closeSidebar as () => void)(),
        },
        "close"
      );
    },
    AutomationsDetailContent: (received: Record<string, unknown>) => {
      record("AutomationsDetailContent", received);
      return React.createElement("div", {
        "data-testid": "stub-AutomationsDetailContent",
      });
    },
  };
});

vi.mock("@/components/app/settings-pane", async () => {
  const React = await import("react");
  return {
    SettingsNavContent: (received: Record<string, unknown>) => {
      record("SettingsNavContent", received);
      const onSectionChange = received.onSectionChange as (
        s: string | null
      ) => void;
      const onSubsectionChange = received.onSubsectionChange as
        | ((s: string) => void)
        | undefined;
      return React.createElement(
        "div",
        { "data-testid": "stub-SettingsNavContent" },
        React.createElement("button", {
          "data-testid": "nav-section-releases",
          onClick: () => onSectionChange("releases"),
        }),
        React.createElement("button", {
          "data-testid": "nav-section-null",
          onClick: () => onSectionChange(null),
        }),
        React.createElement("button", {
          "data-testid": "nav-subsection-faq",
          onClick: () => onSubsectionChange?.("faq"),
        })
      );
    },
    SettingsContent: (received: Record<string, unknown>) => {
      record("SettingsContent", received);
      const onSubsectionChange = received.onSubsectionChange as
        | ((s?: string) => void)
        | undefined;
      return React.createElement(
        "div",
        { "data-testid": "stub-SettingsContent" },
        React.createElement("button", {
          "data-testid": "content-subsection-faq",
          onClick: () => onSubsectionChange?.("faq"),
        }),
        React.createElement("button", {
          "data-testid": "content-subsection-clear",
          onClick: () => onSubsectionChange?.(undefined),
        })
      );
    },
  };
});

vi.mock("@/components/ui/glass-sidebar", async () => {
  const React = await import("react");
  return {
    GlassSidebar: (received: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      mobile?: boolean;
      children?: unknown;
    }) => {
      record("GlassSidebar", received as unknown as Record<string, unknown>);
      return React.createElement(
        "div",
        { "data-testid": "stub-GlassSidebar" },
        React.createElement("button", {
          "data-testid": "glass-open-true",
          onClick: () => received.onOpenChange(true),
        }),
        React.createElement("button", {
          "data-testid": "glass-open-false",
          onClick: () => received.onOpenChange(false),
        }),
        received.children as never
      );
    },
  };
});

vi.mock("@/components/app/sidebar-shell", async () => {
  const React = await import("react");
  return {
    SidebarShell: (received: { children?: unknown }) => {
      record("SidebarShell", received as unknown as Record<string, unknown>);
      return React.createElement(
        "div",
        { "data-testid": "stub-SidebarShell" },
        received.children as never
      );
    },
  };
});

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

function locationPath(): string {
  return screen.getByTestId("location").textContent ?? "";
}

/** "PUSH" leaves the previous entry in history; "REPLACE" discards it. */
function navigationType(): string {
  return screen.getByTestId("navigation-type").textContent ?? "";
}

function defaultContext(): Record<string, unknown> {
  return {
    agents: [],
    enabledAgentTypes: ["claude"],
    setEnabledAgentTypes: vi.fn(),
    enabledIdes: ["vscode"],
    setEnabledIdes: vi.fn(),
    handleLogout: vi.fn(),
    isMobile: false,
    leftOpen: true,
    leftPanelOpen: true,
    mobileLeftOpen: false,
    mobileMediaOpen: false,
    setLeftOpen: vi.fn(),
    setMobileLeftOpen: vi.fn(),
    setMobileMediaOpen: vi.fn(),
    handleSetLeftPanelOpen: vi.fn(),
    apiState: "ok",
    dbState: "ok",
    pulsingNavItem: null,
    triggerNavAnimation: vi.fn(),
    handleSidebarNavigate: vi.fn(),
    currentNavItem: null,
    theme: "cool-navy",
    setTheme: vi.fn(),
    iconColor: "blue",
    setIconColor: vi.fn(),
    isIconColorSaving: false,
    iconColorError: null,
    clearIconColorError: vi.fn(),
  };
}

beforeEach(() => {
  H.clearProps();
  H.context = defaultContext();
});

afterEach(() => {
  cleanup();
});

function propsOf(name: string): Record<string, unknown> {
  const received = H.props.get(name);
  if (!received) throw new Error(`${name} recorded no props`);
  return received;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/automations" element={<AutomationsRoute />} />
        <Route path="/activity/:tab" element={<ActivityRoute />} />
        <Route path="/settings" element={<SettingsRoute />} />
        <Route path="/settings/:section" element={<SettingsRoute />} />
        <Route
          path="/settings/:section/:subsection"
          element={<SettingsRoute />}
        />
      </Routes>
      <LocationProbe />
    </MemoryRouter>
  );
}

describe("serviceDotClass", () => {
  it("maps ok to the working dot", () => {
    expect(serviceDotClass("ok")).toBe("bg-status-working");
  });

  it("maps down to the blocked dot", () => {
    expect(serviceDotClass("down")).toBe("bg-status-blocked");
  });

  it("maps any other state to the waiting dot", () => {
    expect(serviceDotClass("checking")).toBe("bg-status-waiting");
  });
});

describe("SectionShell sidebar open/close wiring", () => {
  it("passes leftOpen (not mobileLeftOpen) as the open prop on desktop", () => {
    Object.assign(H.context, {
      isMobile: false,
      leftOpen: false,
      mobileLeftOpen: true,
    });
    renderAt("/settings");
    expect(propsOf("GlassSidebar").open).toBe(false);
    expect(propsOf("GlassSidebar").mobile).toBe(false);
  });

  it("passes mobileLeftOpen (not leftOpen) as the open prop on mobile", () => {
    Object.assign(H.context, {
      isMobile: true,
      leftOpen: false,
      mobileLeftOpen: true,
    });
    renderAt("/settings");
    expect(propsOf("GlassSidebar").open).toBe(true);
    expect(propsOf("GlassSidebar").mobile).toBe(true);
  });

  it("opens the desktop sidebar through setLeftOpen only, never touching the media flag", () => {
    Object.assign(H.context, { isMobile: false });
    renderAt("/settings");
    fireEvent.click(screen.getByTestId("glass-open-true"));
    expect(H.context.setLeftOpen).toHaveBeenCalledWith(true);
    expect(H.context.setMobileMediaOpen).not.toHaveBeenCalled();
    expect(H.context.setMobileLeftOpen).not.toHaveBeenCalled();
  });

  it("closing the desktop sidebar calls setLeftOpen(false), not the mobile setter", () => {
    Object.assign(H.context, { isMobile: false });
    renderAt("/settings");
    fireEvent.click(screen.getByTestId("glass-open-false"));
    expect(H.context.setLeftOpen).toHaveBeenCalledWith(false);
    expect(H.context.setMobileLeftOpen).not.toHaveBeenCalled();
  });

  it("opening the mobile sidebar also closes the media sidebar", () => {
    Object.assign(H.context, { isMobile: true });
    renderAt("/settings");
    fireEvent.click(screen.getByTestId("glass-open-true"));
    expect(H.context.setMobileMediaOpen).toHaveBeenCalledWith(false);
    expect(H.context.setMobileLeftOpen).toHaveBeenCalledWith(true);
    expect(H.context.setLeftOpen).not.toHaveBeenCalled();
  });

  it("closing the mobile sidebar leaves the media sidebar alone", () => {
    Object.assign(H.context, { isMobile: true });
    renderAt("/settings");
    fireEvent.click(screen.getByTestId("glass-open-false"));
    expect(H.context.setMobileLeftOpen).toHaveBeenCalledWith(false);
    expect(H.context.setMobileMediaOpen).not.toHaveBeenCalled();
  });

  it("shows the floating open-sidebar button only when the left panel is closed", () => {
    Object.assign(H.context, { leftPanelOpen: false });
    renderAt("/settings");
    fireEvent.click(screen.getByTitle("Open sidebar"));
    expect(H.context.handleSetLeftPanelOpen).toHaveBeenCalledWith(true);
  });

  it("hides the floating open-sidebar button when the left panel is already open", () => {
    Object.assign(H.context, { leftPanelOpen: true });
    renderAt("/settings");
    expect(screen.queryByTitle("Open sidebar")).toBeNull();
  });
});

describe("SettingsRoute section navigation", () => {
  it("navigates to the new section with replace and updates active state", () => {
    renderAt("/settings/general");
    fireEvent.click(screen.getByTestId("nav-section-releases"));
    expect(locationPath()).toBe("/settings/releases");
    expect(navigationType()).toBe("REPLACE");
  });

  it("ignores a null section change and performs no navigation", () => {
    renderAt("/settings/general");
    fireEvent.click(screen.getByTestId("nav-section-null"));
    expect(locationPath()).toBe("/settings/general");
  });

  it("closes the mobile sidebar on a section change when on mobile", () => {
    Object.assign(H.context, { isMobile: true });
    renderAt("/settings/general");
    fireEvent.click(screen.getByTestId("nav-section-releases"));
    expect(H.context.setMobileLeftOpen).toHaveBeenCalledWith(false);
  });

  it("does not touch the mobile sidebar on a section change when on desktop", () => {
    Object.assign(H.context, { isMobile: false });
    renderAt("/settings/general");
    fireEvent.click(screen.getByTestId("nav-section-releases"));
    expect(H.context.setMobileLeftOpen).not.toHaveBeenCalled();
  });

  it("routes the nav's subsection change to /settings/help/<sub> with replace", () => {
    renderAt("/settings/help");
    fireEvent.click(screen.getByTestId("nav-subsection-faq"));
    expect(locationPath()).toBe("/settings/help/faq");
    expect(navigationType()).toBe("REPLACE");
  });

  it("closes the mobile sidebar on the nav's subsection change when on mobile", () => {
    Object.assign(H.context, { isMobile: true });
    renderAt("/settings/help");
    fireEvent.click(screen.getByTestId("nav-subsection-faq"));
    expect(H.context.setMobileLeftOpen).toHaveBeenCalledWith(false);
  });

  it("does not touch the mobile sidebar on the nav's subsection change when on desktop", () => {
    Object.assign(H.context, { isMobile: false });
    renderAt("/settings/help");
    fireEvent.click(screen.getByTestId("nav-subsection-faq"));
    expect(H.context.setMobileLeftOpen).not.toHaveBeenCalled();
  });

  it("the content pane's subsection change is dropped outside the help section", () => {
    renderAt("/settings/general");
    fireEvent.click(screen.getByTestId("content-subsection-faq"));
    expect(locationPath()).toBe("/settings/general");
  });

  it("the content pane's subsection change navigates while on the help section", () => {
    renderAt("/settings/help");
    fireEvent.click(screen.getByTestId("content-subsection-faq"));
    expect(locationPath()).toBe("/settings/help/faq");
    expect(navigationType()).toBe("REPLACE");
  });

  it("clearing the content pane's subsection falls back to the bare help route", () => {
    renderAt("/settings/help/faq");
    fireEvent.click(screen.getByTestId("content-subsection-clear"));
    expect(locationPath()).toBe("/settings/help");
  });
});

describe("ActivityRoute tab navigation", () => {
  // The `activityTab ?? "metrics"` fallback in ActivityRoute is unreachable
  // through this route table (and through the real router: router.tsx
  // redirects bare /activity to /activity/metrics before ActivityRoute ever
  // renders), so this only proves the metrics tab is styled active when the
  // URL literally says "metrics" — not the fallback itself.
  it("marks metrics active when the URL tab is metrics", () => {
    renderAt("/activity/metrics");
    expect(screen.getByText("Metrics").className).toContain("bg-primary/10");
    expect(screen.getByText("History").className).not.toContain(
      "bg-primary/10"
    );
  });

  it("marks history active once the URL tab is history", () => {
    renderAt("/activity/history");
    expect(screen.getByText("History").className).toContain("bg-primary/10");
    expect(screen.getByText("Metrics").className).not.toContain(
      "bg-primary/10"
    );
  });

  it("navigates to /activity/history with replace on click", () => {
    renderAt("/activity/metrics");
    fireEvent.click(screen.getByText("History"));
    expect(locationPath()).toBe("/activity/history");
    expect(navigationType()).toBe("REPLACE");
  });

  it("navigates to /activity/metrics with replace on click", () => {
    renderAt("/activity/history");
    fireEvent.click(screen.getByText("Metrics"));
    expect(locationPath()).toBe("/activity/metrics");
    expect(navigationType()).toBe("REPLACE");
  });

  it("closes the mobile sidebar when switching to metrics on mobile", () => {
    Object.assign(H.context, { isMobile: true });
    renderAt("/activity/history");
    fireEvent.click(screen.getByText("Metrics"));
    expect(H.context.setMobileLeftOpen).toHaveBeenCalledWith(false);
  });

  it("does not touch the mobile sidebar when switching to metrics on desktop", () => {
    Object.assign(H.context, { isMobile: false });
    renderAt("/activity/history");
    fireEvent.click(screen.getByText("Metrics"));
    expect(H.context.setMobileLeftOpen).not.toHaveBeenCalled();
  });

  it("closes the mobile sidebar when switching tabs on mobile", () => {
    Object.assign(H.context, { isMobile: true });
    renderAt("/activity/metrics");
    fireEvent.click(screen.getByText("History"));
    expect(H.context.setMobileLeftOpen).toHaveBeenCalledWith(false);
  });

  it("does not touch the mobile sidebar when switching tabs on desktop", () => {
    Object.assign(H.context, { isMobile: false });
    renderAt("/activity/metrics");
    fireEvent.click(screen.getByText("History"));
    expect(H.context.setMobileLeftOpen).not.toHaveBeenCalled();
  });
});

describe("AutomationsRoute", () => {
  it("wires closeSidebar to collapse the mobile nav sidebar", () => {
    Object.assign(H.context, { isMobile: true });
    renderAt("/automations");
    fireEvent.click(screen.getByTestId("close-automations-sidebar"));
    expect(H.context.setMobileLeftOpen).toHaveBeenCalledWith(false);
  });
});
