// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ReleaseInfo,
  UseReleaseStreamResult,
} from "@/hooks/use-release-stream";

// UpdatesSection is a pure view over useReleaseUpdates, so stubbing the hook
// is what lets the real subcomponents (#949 split them out of this file) be
// exercised together.
vi.mock("@/hooks/use-release-updates", () => ({ useReleaseUpdates: vi.fn() }));
vi.mock("@/hooks/use-mac-app-update", () => ({
  useMacAppUpdate: () => ({ data: { connected: false, state: null } }),
  useMacAppUpdateAction: () => ({ mutate: vi.fn() }),
}));

const { useReleaseUpdates } = await import("@/hooks/use-release-updates");
const { UpdatesSection } = await import("./updates-section");

const hookMock = vi.mocked(useReleaseUpdates);
type ReleaseUpdates = ReturnType<typeof useReleaseUpdates>;

const handlers = {
  setNotesExpanded: vi.fn(),
  handleAutoUpdateModeChange: vi.fn(),
  handleChannelChange: vi.fn(),
  handleCheckForUpdates: vi.fn(),
  handleUpdate: vi.fn(),
  handleReload: vi.fn(),
  handleClearCacheAndReload: vi.fn(),
  handleDismiss: vi.fn(),
  retryVersionInfo: vi.fn(),
};

function makeInfo(overrides: Partial<ReleaseInfo> = {}): ReleaseInfo {
  return {
    currentTag: "v1.0.0",
    channel: "stable",
    isAdmin: false,
    latestTag: "v1.1.0",
    updateAvailable: true,
    latestRelease: {
      tag: "v1.1.0",
      publishedAt: "2026-08-01T12:00:00.000Z",
      url: "https://example.test/releases/v1.1.0",
    },
    unreleasedCount: 0,
    commits: [],
    ...overrides,
  };
}

const JOB_FIELDS = {
  startedAt: "2026-08-01T12:00:00.000Z",
  log: ["fetching v1.1.0"],
  runUrl: null,
  tag: "v1.1.0",
  error: null,
  progress: null,
  versionType: null as null,
};

const UPDATE_JOB: NonNullable<ReleaseUpdates["updateJob"]> = {
  ...JOB_FIELDS,
  jobType: "update",
  phase: "fetching",
};

function stubHook(overrides: Partial<ReleaseUpdates> = {}): void {
  hookMock.mockImplementation(() => {
    return {
      status: { tag: "v1.0.0", deployedAt: null },
      infoProgress: null,
      postRestartPolling: false,
      versionInfo: {
        releaseTag: "v1.0.0",
        version: "1.0.0",
        gitSha: null,
        releaseNotes: null,
        releaseUrl: null,
      },
      versionInfoError: false,
      notesExpanded: false,
      channel: "stable",
      channelSaving: false,
      autoUpdateMode: "check",
      autoUpdateSaving: false,
      infoLoading: false,
      infoError: null,
      updateError: null,
      lastCheckMessage: null,
      displayInfo: null,
      updateJob: null,
      isDone: false,
      isFailed: false,
      isRestarting: false,
      showTakeover: false,
      ...handlers,
      ...overrides,
    };
  });
}

function renderSection(): void {
  render(<UpdatesSection stream={{} as UseReleaseStreamResult} />);
}

it("keeps web installation controls out of app-managed installations", () => {
  stubHook({
    versionInfo: {
      updateOwner: "macos-app",
      releaseTag: "v1.0.0",
      version: "1.0.0",
      gitSha: null,
      releaseNotes: null,
      releaseUrl: null,
    },
    displayInfo: makeInfo(),
  });
  renderSection();
  expect(screen.getByText("Update Dispatch")).toBeTruthy();
  expect(screen.queryByTestId("update-button")).toBeNull();
});

it.each([false, true])(
  "withholds installation controls while ownership is unresolved (error=%s)",
  (versionInfoError) => {
    stubHook({ versionInfo: null, versionInfoError, displayInfo: makeInfo() });
    renderSection();
    expect(screen.queryByTestId("update-button")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Check for updates" })
    ).toBeNull();
    if (versionInfoError) {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(handlers.retryVersionInfo).toHaveBeenCalledTimes(1);
    } else {
      expect(screen.getByText("Loading update settings…")).toBeTruthy();
    }
  }
);

beforeEach(() => {
  // Radix Select and DropdownMenu both call scrollIntoView on open; jsdom has
  // no layout engine and does not define it at all, so there is no property to
  // spy on — it has to be installed and then removed again, or every later
  // file sharing this worker sees a fake layout API.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  hookMock.mockReset();
  for (const handler of Object.values(handlers)) handler.mockReset();
});

describe("installing an available update", () => {
  it("offers a one-click update for a newer release", () => {
    stubHook({ displayInfo: makeInfo() });
    renderSection();

    fireEvent.click(screen.getByTestId("update-button"));
    expect(handlers.handleUpdate).toHaveBeenCalledWith("v1.1.0");
  });

  it("offers nothing to install when the install is current", () => {
    stubHook({
      displayInfo: makeInfo({
        updateAvailable: false,
        latestTag: "v1.0.0",
        latestRelease: null,
      }),
      lastCheckMessage: "Up to date",
    });
    renderSection();

    expect(screen.getByText("Up to date")).toBeTruthy();
    expect(screen.queryByTestId("update-button")).toBeNull();
  });
});

describe("an update in flight takes over the section", () => {
  // Leaving the settings column mounted underneath a running update is how a
  // second update gets launched on top of the first one.
  it("replaces the controls while an update runs", () => {
    stubHook({
      displayInfo: makeInfo(),
      updateJob: UPDATE_JOB,
      showTakeover: true,
    });
    renderSection();

    expect(screen.queryByTestId("update-button")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Check for updates" })
    ).toBeNull();
    expect(screen.getByText("Fetching")).toBeTruthy();
    expect(screen.getByText("Deploying")).toBeTruthy();
  });
});

describe("checking for updates", () => {
  it("blocks a second check while one is in flight and reports its progress", () => {
    stubHook({
      infoLoading: true,
      infoProgress: {
        step: "download",
        label: "Downloading release",
        bytesReceived: 512,
        totalBytes: 1024,
      },
    });
    renderSection();

    const button = screen.getByRole("button", { name: "Check for updates" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Downloading release/)).toBeTruthy();

    fireEvent.click(button);
    expect(handlers.handleCheckForUpdates).not.toHaveBeenCalled();
  });

  it("checks on demand and surfaces a check failure", () => {
    stubHook({ infoError: "github unreachable" });
    renderSection();

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(handlers.handleCheckForUpdates).toHaveBeenCalled();
    expect(screen.getByText("github unreachable")).toBeTruthy();
  });
});

describe("preferences and reload", () => {
  it("keeps plain reload and cache-clearing reload on separate actions", () => {
    stubHook();
    renderSection();

    const reload = screen.getByRole("button", { name: /^Reload$/ });
    fireEvent.click(reload);
    expect(handlers.handleReload).toHaveBeenCalled();
    expect(handlers.handleClearCacheAndReload).not.toHaveBeenCalled();

    handlers.handleReload.mockReset();
    // The caret is the split button's other half, so scope the lookup to the
    // pair rather than to whichever menu trigger happens to render first.
    const caret = reload.parentElement?.querySelector('[aria-haspopup="menu"]');
    if (!caret) throw new Error("reload caret not found");
    fireEvent.pointerDown(caret);
    fireEvent.click(screen.getByText("Clear cache & reload"));

    expect(handlers.handleClearCacheAndReload).toHaveBeenCalled();
    expect(handlers.handleReload).not.toHaveBeenCalled();
  });

  // Wiring only — useReleaseUpdates owns the save, so what is pinned here is
  // that each control reports the value it was clicked with rather than a
  // hardcoded one. Persisting it belongs to the hook's own coverage.
  it("reports the picked channel and automatic-update mode", async () => {
    stubHook();
    renderSection();

    fireEvent.click(screen.getByRole("button", { name: "preview" }));
    expect(handlers.handleChannelChange).toHaveBeenCalledWith("preview");

    fireEvent.click(screen.getByTestId("auto-update-mode-select"));
    fireEvent.click(await screen.findByTestId("auto-update-mode-off"));
    expect(handlers.handleAutoUpdateModeChange).toHaveBeenCalledWith("off");
  });
});
