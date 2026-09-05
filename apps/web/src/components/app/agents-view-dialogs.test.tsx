// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";
import type { Template } from "@/hooks/use-templates";

import { AgentsViewDialogs } from "./agents-view-dialogs";

// The cluster renders its real children; only the HTTP seam is mocked. The
// point of these tests is the wiring: each dialog must receive ITS state and
// callbacks (not a sibling's), and the launch dialog's gating/filtering must
// hold.
vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);

function makeAgent(id: string, name: string): Agent {
  return {
    id,
    name,
    type: "claude",
    status: "running",
    cwd: "/repo",
    worktreePath: null,
    worktreeBranch: null,
    tmuxSession: `dispatch-${id}`,
    agentArgs: [],
    model: null,
    fullAccess: false,
    mediaDir: null,
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
  };
}

const agentA = makeAgent("agt_a", "worker-a");
const agentB = makeAgent("agt_b", "worker-b");

function makeTemplate(overrides: Partial<Template> = {}): Template {
  return {
    id: "tpl_1",
    directory: "/repo",
    name: "Nightly Audit",
    description: null,
    prompt: null,
    agentType: "claude",
    model: null,
    useWorktree: false,
    baseBranch: null,
    branchName: null,
    fullAccess: false,
    callable: false,
    allowMedia: false,
    selfImprove: false,
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
    ...overrides,
  };
}

type Props = ComponentProps<typeof AgentsViewDialogs>;

function baseProps(): Props {
  return {
    agents: [],
    paletteOpen: false,
    setPaletteOpen: vi.fn(),
    paletteActions: [],
    paletteGroups: [],
    launchTemplate: null,
    setLaunchTemplateId: vi.fn(),
    enabledAgentTypes: ["claude", "codex", "terminal"],
    createOpen: false,
    initialAgentType: null,
    onCreateOpenChange: vi.fn(),
    resolveCreateDefaultCwd: () => "/repo",
    onAgentCreated: vi.fn().mockResolvedValue(undefined),
    deleteConfirmOpen: false,
    deleteTarget: null,
    setDeleteConfirmOpen: vi.fn(),
    setDeleteTarget: vi.fn(),
    onDelete: vi.fn().mockResolvedValue(undefined),
    stopConfirmOpen: false,
    stopTarget: null,
    setStopConfirmOpen: vi.fn(),
    setStopTarget: vi.fn(),
    onStop: vi.fn().mockResolvedValue(undefined),
    lightboxMediaId: null,
    lightboxMediaIds: [],
    setLightboxMediaId: vi.fn(),
  };
}

function renderDialogs(overrides: Partial<Props> = {}) {
  const props = { ...baseProps(), ...overrides };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <AgentsViewDialogs {...props} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return props;
}

beforeEach(() => {
  apiMock.mockReset();
  // cmdk scrolls the selected option into view and observes the list's size;
  // jsdom provides neither API.
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

afterEach(cleanup);

describe("AgentsViewDialogs", () => {
  it("renders nothing when every dialog is closed", () => {
    renderDialogs();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("media-lightbox")).toBeNull();
  });

  it("routes the delete state to the archive dialog, not the stop dialog", async () => {
    // Both targets set on purpose: a cross-wired dialog would surface worker-b.
    const props = renderDialogs({
      deleteConfirmOpen: true,
      deleteTarget: agentA,
      stopTarget: agentB,
    });

    expect(screen.getByText(/Archive "worker-a"\?/)).toBeTruthy();
    expect(screen.queryByText(/worker-b/)).toBeNull();

    fireEvent.click(screen.getByTestId("delete-agent-confirm"));

    await waitFor(() =>
      expect(props.setDeleteConfirmOpen).toHaveBeenCalledWith(false)
    );
    expect(props.onDelete).toHaveBeenCalledWith(agentA, "auto");
    expect(props.setDeleteTarget).toHaveBeenCalledWith(null);
    expect(props.onStop).not.toHaveBeenCalled();
    expect(props.setStopConfirmOpen).not.toHaveBeenCalled();
  });

  it("routes the stop state to the pause dialog, not the archive dialog", async () => {
    const props = renderDialogs({
      stopConfirmOpen: true,
      stopTarget: agentB,
      deleteTarget: agentA,
    });

    expect(screen.getByText(/Pause "worker-b"\?/)).toBeTruthy();
    expect(screen.queryByText(/worker-a/)).toBeNull();

    fireEvent.click(screen.getByTestId("stop-agent-confirm"));

    await waitFor(() =>
      expect(props.setStopConfirmOpen).toHaveBeenCalledWith(false)
    );
    expect(props.onStop).toHaveBeenCalledWith(agentB);
    expect(props.setStopTarget).toHaveBeenCalledWith(null);
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(props.setDeleteConfirmOpen).not.toHaveBeenCalled();
  });

  it("mounts the launch dialog only for a selected template and clears the id on close", () => {
    const template = makeTemplate();
    const props = renderDialogs({ launchTemplate: template });

    expect(screen.getByText("Nightly Audit")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.setLaunchTemplateId).toHaveBeenCalledWith(null);
  });

  it("offers only CLI agent types in the launch dialog", async () => {
    renderDialogs({
      launchTemplate: makeTemplate(),
      enabledAgentTypes: ["claude", "codex", "cursor", "opencode", "terminal"],
    });

    fireEvent.click(screen.getByRole("combobox", { name: /agent type/i }));

    const options = await screen.findAllByRole("option");
    const labels = options.map((option) => option.textContent);
    expect(labels).toContain("Claude");
    expect(labels).toContain("Codex");
    expect(labels).toContain("Cursor");
    expect(labels).toContain("OpenCode");
    // Terminal agents have no CLI to drive — the wrapper must filter them out.
    expect(labels).not.toContain("Terminal");
  });

  it("wires media IDs into the lightbox so navigation lands correctly", () => {
    apiMock.mockResolvedValue({
      media: {
        id: 2,
        ownerAgentId: "agt_a",
        name: "shot.png",
        size: 2048,
        updatedAt: "2026-07-15T12:00:00.000Z",
        source: "screenshot",
        description: "shot",
        url: "/api/media/shot.png",
      },
    });
    const props = renderDialogs({
      lightboxMediaId: 2,
      lightboxMediaIds: [1, 2, 3],
    });

    expect(screen.getByTestId("media-lightbox")).toBeTruthy();

    // ArrowRight advances to the next stable ID.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(props.setLightboxMediaId).toHaveBeenCalledWith(3);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.setLightboxMediaId).toHaveBeenCalledWith(null);
  });
});
