// @vitest-environment jsdom
import type { AgentCommandsResponse } from "@dispatch/shared";
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

const available = (
  provider: "claude" | "codex" = "claude"
): AgentCommandsResponse => ({
  commands: [{ name: "mcp" }],
  connected: true,
  mcp: { provider, available: true },
});

async function mount(
  data: AgentCommandsResponse | Promise<AgentCommandsResponse>,
  options: { onSend?: ReturnType<typeof vi.fn>; disabledReason?: string } = {}
) {
  vi.mocked(api).mockImplementation(async () => data);
  const onSend = options.onSend ?? vi.fn(async () => {});
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AgentMcpDialog
        agentId="agt_child"
        active
        disabledReason={options.disabledReason ?? null}
        onSend={onSend}
      />
    </QueryClientProvider>
  );
  fireEvent.click(screen.getByRole("button", { name: "MCP servers" }));
  await screen.findByRole("dialog");
  return { onSend, client };
}

const requestStatus = () =>
  screen.getByRole("button", { name: "Request status" }) as HTMLButtonElement;

describe("per-agent MCP diagnostics", () => {
  it.each(["/mcp", "/mcp reconnect"] as const)(
    "submits %s as a queued chat command and closes after acceptance",
    async (command) => {
      const { onSend } = await mount(available());
      await waitFor(() => expect(requestStatus().disabled).toBe(false));
      fireEvent.click(
        screen.getByRole("button", {
          name: command === "/mcp" ? "Request status" : "Reconnect servers",
        })
      );
      await waitFor(() =>
        expect(onSend).toHaveBeenCalledWith(command, [], { delivery: "queue" })
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      fireEvent.click(screen.getByRole("button", { name: "MCP servers" }));
      expect(screen.getByRole("dialog")).toBeTruthy();
    }
  );

  it("keeps Codex reconnect scope visible and discloses conditional troubleshooting on request", async () => {
    await mount(available("codex"));
    await screen.findByText(
      /Reconnect reloads MCP configuration for all sessions/
    );
    const toggle = screen.getByRole("button", {
      name: "Troubleshooting",
    });
    const panel = document.getElementById(
      toggle.getAttribute("aria-controls")!
    )!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(panel.hidden).toBe(true);
    expect(screen.getByText(/It may require sign-in/)).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(panel.hidden).toBe(false);
    expect(
      screen.getByText(/If Codex configuration already defines/)
    ).toBeTruthy();
    expect(
      screen.getByText(/Effective settings are not available here/)
    ).toBeTruthy();
    fireEvent.click(toggle);
    expect(panel.hidden).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Reconnect servers",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);
  });

  it.each([
    {
      data: {
        ...available(),
        connected: false,
        commands: [],
        mcp: { provider: "claude" as const, available: false },
      },
      message: /no connected session/,
    },
    {
      data: {
        ...available(),
        commands: [],
        mcp: { provider: "claude" as const, available: false },
      },
      message: /not supported/,
    },
    {
      data: { ...available(), mcp: { provider: null, available: false } },
      message: /not supported/,
    },
  ])(
    "disables commands for unavailable sessions ($message)",
    async ({ data, message }) => {
      const { onSend } = await mount(data);
      await screen.findByText(message);
      expect(requestStatus().disabled).toBe(true);
      fireEvent.click(requestStatus());
      expect(onSend).not.toHaveBeenCalled();
    }
  );

  it("keeps actions disabled until discovery finishes", async () => {
    let resolve!: (data: AgentCommandsResponse) => void;
    await mount(
      new Promise((done) => {
        resolve = done;
      })
    );
    expect(screen.getByText(/Checking available commands/)).toBeTruthy();
    expect(requestStatus().disabled).toBe(true);
    resolve(available());
    await waitFor(() => expect(requestStatus().disabled).toBe(false));
  });

  it("shows a discovery failure and permits refresh without exposing the error payload", async () => {
    vi.mocked(api).mockRejectedValue(new Error("token=private"));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <AgentMcpDialog
          agentId="agt_1"
          active
          disabledReason={null}
          onSend={vi.fn()}
        />
      </QueryClientProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "MCP servers" }));
    await screen.findByText(/Could not check this agent/);
    expect(requestStatus().disabled).toBe(true);
    expect(screen.queryByText(/private/)).toBeNull();
    vi.mocked(api).mockResolvedValue(available());
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh availability" })
    );
    await waitFor(() => expect(requestStatus().disabled).toBe(false));
  });

  it("honors the composer delivery restriction", async () => {
    await mount(available(), { disabledReason: "Agent is archived." });
    await screen.findByText("Agent is archived.");
    expect(requestStatus().disabled).toBe(true);
  });

  it("keeps the dialog open after submission fails and does not copy error details", async () => {
    const onSend = vi
      .fn()
      .mockRejectedValue(new Error("Authorization: secret"));
    await mount(available(), { onSend });
    await waitFor(() => expect(requestStatus().disabled).toBe(false));
    fireEvent.click(requestStatus());
    await screen.findByRole("alert");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByText(/secret/)).toBeNull();
  });
});
