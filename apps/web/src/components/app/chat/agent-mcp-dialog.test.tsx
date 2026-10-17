// @vitest-environment jsdom
import type { AgentMcpInventoryResponse } from "@dispatch/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { createRef } from "react";
import { AgentMcpDialog, type McpInventoryControl } from "./agent-mcp-dialog";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));
beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false }))
  );
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
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
const controlRef = createRef<McpInventoryControl>();
function mount(agentId = "child") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <AgentMcpDialog controlRef={controlRef} agentId={agentId} active online />
    </QueryClientProvider>
  );
  return {
    ...view,
    client,
    switchTo: (id: string) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <AgentMcpDialog controlRef={controlRef} agentId={id} active online />
        </QueryClientProvider>
      ),
  };
}
const open = () => act(() => controlRef.current?.open());
describe("read-only per-agent MCP inventory", () => {
  it("keeps cached reopen focus off search on touch devices", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true }))
    );
    vi.mocked(api)
      .mockResolvedValueOnce(data)
      .mockImplementation(() => new Promise(() => {}));
    mount();
    open();
    await screen.findByText("alpha");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    open();
    await screen.findByText("alpha");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("dialog"))
    );
    expect(
      screen
        .getByRole("button", { name: "Refresh MCP inventory" })
        .hasAttribute("disabled")
    ).toBe(true);
  });

  it("shows initial loading but keeps inventory visible during refresh", async () => {
    let resolve!: (value: AgentMcpInventoryResponse) => void;
    vi.mocked(api).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done as typeof resolve;
        })
    );
    mount();
    open();
    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      "Reading servers…"
    );
    resolve(data);
    await screen.findByText("alpha");
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh MCP inventory" })
    );
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.queryByText("Reading servers…")).toBeNull();
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Refresh MCP inventory" })
          .hasAttribute("disabled")
      ).toBe(true)
    );
    resolve(data);
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Refresh MCP inventory" })
          .hasAttribute("disabled")
      ).toBe(false)
    );
  });
  it("sorts servers and tools alphabetically and avoids redundant sign-in details", async () => {
    vi.mocked(api).mockResolvedValue({
      ...data,
      inventory: {
        version: 1,
        servers: [
          {
            name: "Zulu",
            state: "needs-auth",
            toolsState: "error",
            tools: null,
          },
          {
            name: "alpha",
            state: "connected",
            toolsState: "known",
            tools: [{ name: "zebra" }, { name: "Apple" }, { name: "beta" }],
          },
        ],
      },
    });
    mount();
    open();
    await screen.findByText("alpha");
    const rows = within(screen.getByLabelText("MCP server list")).getAllByRole(
      "button"
    );
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "alpha Connected · 3 tools",
      "Zulu Sign-in needed",
    ]);
    expect(rows[0]!.textContent).toBe("alpha3 tools");
    expect(rows[1]!.textContent).toBe("Zulu");
    fireEvent.click(rows[0]!);
    expect(screen.getByLabelText("alpha tools").textContent).toBe(
      "Applebetazebra"
    );
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Zulu Sign-in needed" })
    );
    expect(screen.queryByText("Tool discovery failed.")).toBeNull();
    expect(screen.queryByText("Tools are not available yet.")).toBeNull();
  });
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
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Back" })
    );
    expect(document.activeElement).not.toBe(
      screen.getByLabelText("Search alpha tools")
    );
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
    await screen.findByText("Reading servers…");
    view.switchTo("other");
    open();
    await screen.findByText("No MCP servers reported.");
    resolve(data);
    await waitFor(() => expect(screen.queryByText("alpha")).toBeNull());
    expect(screen.getByText("No MCP servers reported.")).toBeTruthy();
  });
});
