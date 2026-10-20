// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TerminalDrawer from "./terminal-drawer";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    loadAddon() {}
    open() {}
    write() {}
    focus() {}
    dispose() {}
    onData() {
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  onopen?: () => void;
  onmessage?: (event: MessageEvent) => void;
  onclose?: (event: CloseEvent) => void;
  send = vi.fn();
  close = vi.fn();
  constructor() {
    Socket.instances.push(this);
  }
}
const info = {
  id: "terminal-id",
  host: "host",
  user: "user",
  cwd: "/workspace",
  unencrypted: false,
};
beforeEach(() => {
  Socket.instances = [];
  sessionStorage.clear();
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("terminal drawer", () => {
  it("keeps its shell connection while hidden and ends through a bodyless DELETE", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => info })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetch);
    const props = { agentId: "agent" };
    const { rerender } = render(<TerminalDrawer {...props} active />);
    await waitFor(() => expect(Socket.instances).toHaveLength(1));
    act(() => Socket.instances[0].onopen?.());
    expect(screen.getByRole("status").textContent).toBe("Connected");
    rerender(<TerminalDrawer {...props} active={false} />);
    expect(Socket.instances[0].close).not.toHaveBeenCalled();
    rerender(<TerminalDrawer {...props} active />);
    fireEvent.click(screen.getByRole("button", { name: "End terminal" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Ended")
    );
    expect(fetch.mock.calls[1]).toEqual([
      "/api/v1/human-terminals/terminal-id",
      expect.objectContaining({
        method: "DELETE",
        headers: undefined,
        body: undefined,
      }),
    ]);
    expect(Socket.instances[0].close).toHaveBeenCalledOnce();
  });
  it("recovers an expired stored session automatically", async () => {
    sessionStorage.setItem("dispatch:human-terminal:agent", "expired-id");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: "expired" }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => info });
    vi.stubGlobal("fetch", fetch);
    render(<TerminalDrawer agentId="agent" active />);
    expect(screen.queryByLabelText("Host terminal")).toBeNull();
    await waitFor(() => expect(Socket.instances).toHaveLength(1));
    expect(JSON.parse(fetch.mock.calls[0][1].body).terminalId).toBe(
      "expired-id"
    );
    expect(JSON.parse(fetch.mock.calls[1][1].body).terminalId).toBeUndefined();
    act(() => Socket.instances[0].onopen?.());
    expect(screen.getByLabelText("Host terminal")).toBeTruthy();
  });
  it("keeps an explicitly ended session ended across remounts until New terminal", async () => {
    sessionStorage.setItem("dispatch:human-terminal:agent", "ended");
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => info });
    vi.stubGlobal("fetch", fetch);
    render(<TerminalDrawer agentId="agent" active />);
    expect(screen.getByRole("status").textContent).toBe("Ended");
    expect(screen.queryByLabelText("Host terminal")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    await waitFor(() => expect(Socket.instances).toHaveLength(1));
  });
  it("shows exit without an active canvas and offers one New terminal action", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => info })
    );
    render(<TerminalDrawer agentId="agent" active />);
    await waitFor(() => expect(Socket.instances).toHaveLength(1));
    act(() => Socket.instances[0].onopen?.());
    act(() =>
      Socket.instances[0].onmessage?.({
        data: JSON.stringify({ type: "exit", code: 0 }),
      } as MessageEvent)
    );
    expect(screen.getByRole("status").textContent).toBe("Exited (0)");
    expect(screen.queryByLabelText("Host terminal")).toBeNull();
    expect(screen.queryByRole("button", { name: "End terminal" })).toBeNull();
    expect(screen.getByRole("button", { name: "New terminal" })).toBeTruthy();
  });
  it("shows the browser setup/auth error and actives no socket when rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: "Set up a password and sign in." }),
      })
    );
    render(<TerminalDrawer agentId="agent" active />);
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toBe(
      "Set up a password and sign in."
    );
    expect(Socket.instances).toHaveLength(0);
  });
  it("ignores a previous agent's delayed connection after switching agents", async () => {
    let resolveFirst!: (value: unknown) => void;
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ...info,
          id: "second-terminal",
          host: "second-host",
        }),
      });
    vi.stubGlobal("fetch", fetch);
    const { rerender } = render(
      <TerminalDrawer key="first" agentId="first" active />
    );
    rerender(<TerminalDrawer key="second" agentId="second" active />);
    await waitFor(() => expect(Socket.instances).toHaveLength(1));
    await act(async () => {
      resolveFirst({ ok: true, json: async () => info });
    });
    expect(Socket.instances).toHaveLength(1);
    expect(sessionStorage.getItem("dispatch:human-terminal:first")).toBeNull();
    expect(screen.getByText("user@second-host")).toBeTruthy();
  });
  it("ignores a held reconnect response and late socket events after End succeeds", async () => {
    let resolveResume!: (value: unknown) => void;
    const heldResume = new Promise((resolve) => {
      resolveResume = resolve;
    });
    let resolveEnd!: (value: unknown) => void;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => info })
      .mockImplementationOnce(() => heldResume)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveEnd = resolve;
          })
      );
    vi.stubGlobal("fetch", fetch);
    render(<TerminalDrawer agentId="agent" active />);
    await waitFor(() => expect(Socket.instances).toHaveLength(1));
    act(() => Socket.instances[0].onopen?.());
    vi.useFakeTimers();
    try {
      act(() => Socket.instances[0].onclose?.({ code: 1006 } as CloseEvent));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "End terminal" }));
      });
      expect(screen.getByRole("status").textContent).toBe("Ending");
      await act(async () => {
        resolveResume({ ok: true, json: async () => info });
      });
      act(() => Socket.instances[0].onopen?.());
      expect(Socket.instances).toHaveLength(1);
      expect(screen.getByRole("status").textContent).toBe("Ending");
      await act(async () => {
        resolveEnd({ ok: true, json: async () => ({ ok: true }) });
      });
      expect(screen.getByRole("status").textContent).toBe("Ended");
      expect(screen.getByRole("button", { name: "New terminal" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
