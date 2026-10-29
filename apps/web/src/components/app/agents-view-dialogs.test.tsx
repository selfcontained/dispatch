// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";
import type { Template } from "@/hooks/use-templates";
import { createAgentLocationPrefAtom } from "@/lib/store";

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
    agentArgs: [],
    model: null,
    fullAccess: false,
    filesDir: null,
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
    allowFiles: false,
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
    enabledAgentTypes: ["claude", "codex"],
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
    lightboxFileId: null,
    lightboxFileIds: [],
    setLightboxFileId: vi.fn(),
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
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
});

afterEach(cleanup);

describe("AgentsViewDialogs", () => {
  it("opens from sidebar scope ahead of remembered location and viewed cwd, then permits manual changes", async () => {
    const projects = [
      {
        id: "project-a",
        name: "Project A",
        repoRoot: "/repo/a",
        updatedAt: "2026-10-01",
      },
      {
        id: "project-b",
        name: "Project B",
        repoRoot: "/repo/b",
        updatedAt: "2026-10-01",
      },
    ];
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(["projects"], projects);
    const store = createStore();
    store.set(createAgentLocationPrefAtom, {
      mode: "project",
      projectId: "project-b",
    });
    apiMock.mockImplementation(async (path) => {
      if (path.startsWith("/api/v1/personas?")) return { personas: [] };
      if (path.startsWith("/api/v1/history/projects")) return { projects: [] };
      if (path === "/api/v1/system/defaults") return { homeDir: "/home/test" };
      if (path === "/api/v1/agent-models") return { models: {} };
      if (path === "/api/v1/system/engines") return { engines: [] };
      if (path.includes("/path-info?"))
        return { exists: true, isDirectory: true, isGitRepo: false };
      return [];
    });
    function Host() {
      const navigate = useNavigate();
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open Create</button>
          <button onClick={() => navigate("/agents?project=project-b")}>
            Select B
          </button>
          <AgentsViewDialogs
            {...baseProps()}
            createOpen={open}
            onCreateOpenChange={setOpen}
            resolveCreateDefaultCwd={() => "/viewed/c"}
          />
        </>
      );
    }
    render(
      <JotaiProvider store={store}>
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={["/agents?project=project-a"]}>
            <Host />
          </MemoryRouter>
        </QueryClientProvider>
      </JotaiProvider>
    );
    try {
      fireEvent.click(screen.getByRole("button", { name: "Open Create" }));
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Choose project" }).textContent
        ).toContain("Project A")
      );
      expect(screen.getByTestId("create-agent-cwd")).toHaveProperty(
        "value",
        "/repo/a"
      );
      fireEvent.click(screen.getByTestId("create-agent-cancel"));
      fireEvent.click(screen.getByRole("button", { name: "Select B" }));
      fireEvent.click(screen.getByRole("button", { name: "Open Create" }));
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Choose project" }).textContent
        ).toContain("Project B")
      );
      expect(screen.getByTestId("create-agent-cwd")).toHaveProperty(
        "value",
        "/repo/b"
      );
      fireEvent.pointerDown(
        screen.getByRole("button", { name: "Choose project" }),
        { button: 0, ctrlKey: false, pointerType: "mouse" }
      );
      fireEvent.click(
        await screen.findByRole("menuitem", { name: /Project A/ })
      );
      expect(screen.getByTestId("create-agent-cwd")).toHaveProperty(
        "value",
        "/repo/a"
      );
      expect(
        screen.getByRole("button", { name: "Choose project" }).textContent
      ).toContain("Project A");
    } finally {
      cleanup();
      client.clear();
    }
  });

  it("renders nothing when every dialog is closed", () => {
    renderDialogs();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("file-lightbox")).toBeNull();
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

  it("offers the enabled agent types in the launch dialog", async () => {
    renderDialogs({
      launchTemplate: makeTemplate(),
      enabledAgentTypes: ["claude", "codex"],
    });

    fireEvent.click(screen.getByRole("combobox", { name: /agent type/i }));

    const options = await screen.findAllByRole("option");
    const labels = options.map((option) => option.textContent);
    expect(labels).toEqual(["Claude", "Codex"]);
  });

  it("wires file IDs into the lightbox so navigation lands correctly", () => {
    apiMock.mockResolvedValue({
      file: {
        id: 2,
        ownerAgentId: "agt_a",
        name: "shot.png",
        size: 2048,
        updatedAt: "2026-07-15T12:00:00.000Z",
        source: "screenshot",
        description: "shot",
        url: "/api/files/shot.png",
      },
    });
    const props = renderDialogs({
      lightboxFileId: 2,
      lightboxFileIds: [1, 2, 3],
    });

    expect(screen.getByTestId("file-lightbox")).toBeTruthy();

    // ArrowRight advances to the next stable ID.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(props.setLightboxFileId).toHaveBeenCalledWith(3);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.setLightboxFileId).toHaveBeenCalledWith(null);
  });
});
