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
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? children : null,
  SheetContent: ({ children }: { children: React.ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  SheetTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  SheetDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
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
    const props = { agentId: "agent", onOpenChange: vi.fn() };
    const { rerender } = render(<TerminalDrawer {...props} open />);
    await waitFor(() => expect(Socket.instances).toHaveLength(1));
    act(() => Socket.instances[0].onopen?.());
    expect(screen.getByRole("status").textContent).toBe("Connected");
    rerender(<TerminalDrawer {...props} open={false} />);
    expect(Socket.instances[0].close).not.toHaveBeenCalled();
    rerender(<TerminalDrawer {...props} open />);
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
  it("shows the browser setup/auth error and opens no socket when rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: "Set up a password and sign in." }),
      })
    );
    render(<TerminalDrawer agentId="agent" open onOpenChange={vi.fn()} />);
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toBe(
      "Set up a password and sign in."
    );
    expect(Socket.instances).toHaveLength(0);
  });
});
