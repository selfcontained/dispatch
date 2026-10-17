// @vitest-environment jsdom
import type { AgentMcpInventoryResponse } from "@dispatch/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { AgentMcpDialog } from "./agent-mcp-dialog";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const data: AgentMcpInventoryResponse = {
  agentId: "child",
  status: "ok",
  inventory: {
    version: 1,
    servers: [
      {
        name: "alpha",
        state: "connected",
        toolsState: "known",
        tools: [{ name: "read_item", description: "Read the selected item." }],
      },
      { name: "beta", state: "connected", toolsState: "known", tools: [] },
      { name: "gamma", state: "failed", toolsState: "error", tools: null },
      { name: "delta", state: "pending", toolsState: "unknown", tools: null },
    ],
  },
};
function mount(agentId = "child") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <AgentMcpDialog agentId={agentId} active />
    </QueryClientProvider>
  );
  return {
    ...view,
    client,
    switchTo: (id: string) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <AgentMcpDialog agentId={id} active />
        </QueryClientProvider>
      ),
  };
}
const open = () =>
  fireEvent.click(screen.getByRole("button", { name: "MCP servers" }));
describe("read-only per-agent MCP inventory", () => {
  it("fetches only on open and searches native tools and descriptions; Back retains filter and focus", async () => {
    vi.mocked(api).mockResolvedValue(data);
    mount();
    expect(api).not.toHaveBeenCalled();
    open();
    await screen.findByText("alpha");
    fireEvent.change(screen.getByLabelText("Search MCP servers"), {
      target: { value: "alp" },
    });
    fireEvent.click(screen.getByRole("button", { name: /alpha Connected/ }));
    fireEvent.change(screen.getByLabelText("Search alpha tools"), {
      target: { value: "selected" },
    });
    fireEvent.click(screen.getByRole("button", { name: "read_item" }));
    expect(screen.getByText("Read the selected item.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(
      (screen.getByLabelText("Search MCP servers") as HTMLInputElement).value
    ).toBe("alp");
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain("alpha")
    );
    expect(api).toHaveBeenCalledWith(
      "/api/v1/agents/child/mcp-inventory",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(
      vi
        .mocked(api)
        .mock.calls.every(([, init]) => !init?.method || init.method === "GET")
    ).toBe(true);
    expect(
      screen.queryByText(/Reconnect servers|Request status|Sign in/)
    ).toBeNull();
  });
  it("distinguishes known empty, unknown, and failed tool discovery", async () => {
    vi.mocked(api).mockResolvedValue(data);
    mount();
    open();
    await screen.findByText("beta");
    fireEvent.click(screen.getByRole("button", { name: /beta Connected/ }));
    expect(screen.getByText("No tools reported.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: /delta Connecting/ }));
    expect(screen.getByText("Tools are not available yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: /gamma Connection/ }));
    expect(screen.getByText("Tool discovery failed.")).toBeTruthy();
  });
  it.each([
    ["offline", "This agent is offline."],
    [
      "unsupported",
      "Inventory is unavailable in this agent’s current session.",
    ],
    ["timeout", "Inventory request timed out."],
    ["unavailable", "Inventory is temporarily unavailable."],
  ] as const)("shows %s honestly", async (status, message) => {
    vi.mocked(api).mockResolvedValue({
      agentId: "child",
      status,
      inventory: null,
    });
    mount();
    open();
    expect(await screen.findByText(message)).toBeTruthy();
  });
  it("removes cached counts and tools when a live refresh fails", async () => {
    vi.mocked(api)
      .mockResolvedValueOnce(data)
      .mockRejectedValueOnce(new Error("network"));
    mount();
    open();
    await screen.findByText("alpha");
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh MCP inventory" })
    );
    await screen.findByText("Could not read MCP inventory.");
    expect(screen.queryByText("MCP servers · 4")).toBeNull();
    expect(screen.queryByText("alpha")).toBeNull();
  });
  it("keeps the attention filter removable after every server recovers", async () => {
    vi.mocked(api)
      .mockResolvedValueOnce(data)
      .mockResolvedValue({
        ...data,
        inventory: {
          version: 1,
          servers: data.inventory!.servers.map((server) => ({
            ...server,
            state: "connected",
          })),
        },
      });
    mount();
    open();
    fireEvent.click(
      await screen.findByRole("button", { name: "Needs attention · 2" })
    );
    expect(screen.queryByText("alpha")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh MCP inventory" })
    );
    const filter = await screen.findByRole("button", {
      name: "Needs attention · 0",
    });
    expect(filter.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(filter);
    expect(await screen.findByText("alpha")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Needs attention · 0" })
    ).toBeNull();
  });
  it("does not publish late inventory after switching target child", async () => {
    let resolve!: (value: AgentMcpInventoryResponse) => void;
    vi.mocked(api).mockImplementation((path) =>
      path.includes("/child/")
        ? new Promise((r) => {
            resolve = r as typeof resolve;
          })
        : Promise.resolve({
            agentId: "other",
            status: "ok",
            inventory: { version: 1, servers: [] },
          })
    );
    const view = mount();
    open();
    await screen.findByText("Loading MCP servers…");
    view.switchTo("other");
    open();
    await screen.findByText("No MCP servers reported.");
    resolve(data);
    await waitFor(() => expect(screen.queryByText("alpha")).toBeNull());
    expect(screen.getByText("No MCP servers reported.")).toBeTruthy();
  });
});
