// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AssistedUpdateMetadata,
  ReleaseInfo,
  UseReleaseStreamResult,
} from "@/hooks/use-release-stream";

// UpdatesSection is a pure view over useReleaseUpdates, so stubbing the hook
// is what lets the real subcomponents (#949 split them out of this file) be
// exercised together: the safety routing that decides whether a standard
// update runs on one click or has to pass the force confirmation spans
// UpdatesCheckPanel -> UpdateActions -> UpdatesForceConfirmDialog, and no
// single one of them owns it.
vi.mock("@/hooks/use-release-updates", () => ({ useReleaseUpdates: vi.fn() }));

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
  handleAssistedUpdate: vi.fn(),
  handleReload: vi.fn(),
  handleClearCacheAndReload: vi.fn(),
  handleDismiss: vi.fn(),
  handleAssistedDismiss: vi.fn(),
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

function makeAssisted(
  overrides: Partial<AssistedUpdateMetadata> = {}
): AssistedUpdateMetadata {
  return {
    mode: "required",
    title: "Service manager rewrite",
    summary: "The launchd plist changes shape.",
    requiredChecks: [],
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

const ASSISTED_JOB: NonNullable<ReleaseUpdates["assistedJob"]> = {
  ...JOB_FIELDS,
  jobType: "update-assisted",
  phase: "apply",
  assisted: {
    tag: "v1.1.0",
    fromTag: "v1.0.0",
    metadata: makeAssisted(),
    migrations: null,
    requiredChecks: [],
    phase: "apply",
    token: "tok",
    agentId: null,
    startedAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
    completedAt: null,
    error: null,
    checks: [],
    notes: {},
  },
};

/**
 * `forceConfirmOpen` really lives in useReleaseUpdates, so the stub holds it
 * in real state — that is what lets one test click the demoted standard
 * update and then the confirmation as a single chain rather than stopping at
 * "the setter was called".
 */
function stubHook(overrides: Partial<ReleaseUpdates> = {}): void {
  hookMock.mockImplementation(() => {
    const [forceConfirmOpen, setForceConfirmOpen] = useState(false);
    return {
      status: { tag: "v1.0.0", deployedAt: null },
      infoProgress: null,
      postRestartPolling: false,
      versionInfo: null,
      notesExpanded: false,
      channel: "stable",
      channelSaving: false,
      autoUpdateMode: "check",
      autoUpdateSaving: false,
      infoLoading: false,
      infoError: null,
      updateError: null,
      assistedUpdateLaunching: false,
      lastCheckMessage: null,
      displayInfo: null,
      updateJob: null,
      assistedJob: null,
      isDone: false,
      isFailed: false,
      isRestarting: false,
      showTakeover: false,
      ...handlers,
      ...overrides,
      forceConfirmOpen,
      setForceConfirmOpen,
    };
  });
}

function renderSection(): void {
  render(<UpdatesSection stream={{} as UseReleaseStreamResult} />);
}

/** Opens the caret half of a split button and returns nothing. */
function openSplitMenu(label: string): void {
  fireEvent.pointerDown(screen.getByRole("button", { name: label }));
}

beforeEach(() => {
  // Radix Select and DropdownMenu both call scrollIntoView on open; jsdom has
  // no layout engine and does not define it at all.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  hookMock.mockReset();
  for (const handler of Object.values(handlers)) handler.mockReset();
});

describe("standard vs assisted update routing", () => {
  it("offers a one-click standard update for a plain release", () => {
    stubHook({ displayInfo: makeInfo() });
    renderSection();

    expect(screen.queryByTestId("assisted-update-button")).toBeNull();
    fireEvent.click(screen.getByTestId("standard-update-button"));

    // Exactly one argument: a stray force flag here would silently bypass a
    // gate that has not been shown to the operator.
    expect(handlers.handleUpdate).toHaveBeenCalledWith("v1.1.0");
    expect(screen.queryByTestId("force-standard-update-confirm")).toBeNull();
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
    expect(screen.queryByTestId("standard-update-button")).toBeNull();
    expect(screen.queryByTestId("assisted-update-button")).toBeNull();
  });

  it("gates a required release behind the force confirmation", () => {
    stubHook({
      displayInfo: makeInfo({
        assisted: makeAssisted(),
        assistedRequired: true,
      }),
    });
    renderSection();

    // The assisted flow takes the primary slot; standard is demoted.
    expect(screen.getByTestId("assisted-update-button")).toBeTruthy();
    expect(screen.queryByTestId("standard-update-button")).toBeNull();

    openSplitMenu("More update options");
    fireEvent.click(screen.getByTestId("standard-update-menu-item"));

    // The menu item must open the confirmation, not run the update.
    expect(handlers.handleUpdate).not.toHaveBeenCalled();
    expect(screen.getByText("Skip the agent-assisted update?")).toBeTruthy();
    expect(screen.getByText(/needs the agent for a safe update/)).toBeTruthy();

    fireEvent.click(screen.getByTestId("force-standard-update-confirm"));

    expect(handlers.handleUpdate).toHaveBeenCalledWith("v1.1.0", {
      force: true,
    });
    expect(screen.queryByTestId("force-standard-update-confirm")).toBeNull();
  });

  it("cancelling the force confirmation leaves the update unrun", () => {
    stubHook({
      displayInfo: makeInfo({
        assisted: makeAssisted(),
        assistedRequired: true,
      }),
    });
    renderSection();

    openSplitMenu("More update options");
    fireEvent.click(screen.getByTestId("standard-update-menu-item"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(handlers.handleUpdate).not.toHaveBeenCalled();
    expect(screen.queryByTestId("force-standard-update-confirm")).toBeNull();
  });

  it("gates the standard update when the release declares pending migrations", () => {
    stubHook({
      displayInfo: makeInfo({
        pendingMigrations: [
          { id: "0001", title: "Move the socket", summary: "Relocates it." },
        ],
      }),
    });
    renderSection();

    expect(screen.getByTestId("pending-migrations-gate")).toBeTruthy();
    expect(screen.queryByTestId("standard-update-button")).toBeNull();

    openSplitMenu("More update options");
    fireEvent.click(screen.getByTestId("standard-update-menu-item"));

    expect(handlers.handleUpdate).not.toHaveBeenCalled();
    expect(
      screen.getByText(/has 1 complex update step; safer with the agent/)
    ).toBeTruthy();
  });

  it("warns about an unevaluated migration set without gating the update", () => {
    stubHook({
      displayInfo: makeInfo({ migrationsError: "manifest 0002 is malformed" }),
    });
    renderSection();

    // A checker that could not run is not evidence of a risky update — the
    // one-click path has to stay open or a broken manifest strands everyone.
    expect(screen.getByTestId("migration-eval-warning")).toBeTruthy();
    fireEvent.click(screen.getByTestId("standard-update-button"));
    expect(handlers.handleUpdate).toHaveBeenCalledWith("v1.1.0");
  });

  it("promotes a recommended assisted release without forcing a confirmation", () => {
    stubHook({
      displayInfo: makeInfo({
        assisted: makeAssisted({ mode: "recommended" }),
      }),
    });
    renderSection();

    expect(screen.getByTestId("assisted-update-button")).toBeTruthy();
    openSplitMenu("More update options");
    fireEvent.click(screen.getByTestId("standard-update-menu-item"));

    expect(handlers.handleUpdate).toHaveBeenCalledWith("v1.1.0");
    expect(screen.queryByTestId("force-standard-update-confirm")).toBeNull();
  });

  it("runs the assisted update from the primary button", () => {
    stubHook({
      displayInfo: makeInfo({
        assisted: makeAssisted(),
        assistedRequired: true,
      }),
    });
    renderSection();

    fireEvent.click(screen.getByTestId("assisted-update-button"));
    expect(handlers.handleAssistedUpdate).toHaveBeenCalledWith("v1.1.0");
  });
});

describe("an update in flight takes over the section", () => {
  // Leaving the settings column mounted underneath a running update is how a
  // second update gets launched on top of the first one.
  it("replaces the controls while a standard update runs", () => {
    stubHook({
      displayInfo: makeInfo(),
      updateJob: UPDATE_JOB,
      showTakeover: true,
    });
    renderSection();

    expect(screen.queryByTestId("standard-update-button")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Check for updates" })
    ).toBeNull();
  });

  it("replaces the controls while an assisted update runs", () => {
    stubHook({ displayInfo: makeInfo(), assistedJob: ASSISTED_JOB });
    renderSection();

    expect(screen.getByText("Assisted update")).toBeTruthy();
    expect(screen.queryByTestId("assisted-update-button")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Check for updates" })
    ).toBeNull();
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

  it("persists a channel switch and an automatic-update change", async () => {
    stubHook();
    renderSection();

    fireEvent.click(screen.getByRole("button", { name: "latest" }));
    expect(handlers.handleChannelChange).toHaveBeenCalledWith("latest");

    fireEvent.click(screen.getByTestId("auto-update-mode-select"));
    fireEvent.click(await screen.findByTestId("auto-update-mode-off"));
    expect(handlers.handleAutoUpdateModeChange).toHaveBeenCalledWith("off");
  });
});
