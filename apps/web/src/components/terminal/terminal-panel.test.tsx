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
import TerminalPanel from "./terminal-panel";

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

describe("terminal panel", () => {
  it("opens a fresh shell instead of retaining the legacy lost-session marker", async () => {
    sessionStorage.setItem("dispatch:human-terminal:agent", "ended");
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => info });
    vi.stubGlobal("fetch", fetch);
    render(<TerminalPanel agentId="agent" active />);
    await waitFor(() => expect(Socket.instances).toHaveLength(1));
    expect(JSON.parse(fetch.mock.calls[0][1].body).terminalId).toBeUndefined();
    act(() => Socket.instances[0].onopen?.());
    expect(screen.getByRole("status").textContent).toBe("Connected");
    expect(sessionStorage.getItem("dispatch:human-terminal:agent")).toBe(
      info.id
    );
  });
  it("automatically replaces a session lost between resume and socket attachment", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => info });
    vi.stubGlobal("fetch", fetch);
    render(<TerminalPanel agentId="agent" active />);
    await waitFor(() => expect(Socket.instances).toHaveLength(1));
    act(() => Socket.instances[0].onopen?.());
    vi.useFakeTimers();
    try {
      act(() =>
        Socket.instances[0].onclose?.({
          code: 1008,
          reason: "Terminal not found.",
        } as CloseEvent)
      );
      expect(screen.getByRole("status").textContent).toBe("Connecting");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("button", { name: "New terminal" })).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(Socket.instances).toHaveLength(2);
      expect(
        JSON.parse(fetch.mock.calls[1][1].body).terminalId
      ).toBeUndefined();
      act(() => Socket.instances[1].onopen?.());
      expect(screen.getByRole("status").textContent).toBe("Connected");
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([false, true])(
    "bounds missing-session retries and resets only on server confirmation (confirmed=%s)",
    async (confirmed) => {
      const fetch = vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => info });
      vi.stubGlobal("fetch", fetch);
      render(<TerminalPanel agentId="agent" active />);
      await waitFor(() => expect(Socket.instances).toHaveLength(1));
      vi.useFakeTimers();
      try {
        const loseSession = async () => {
          const socket = Socket.instances.at(-1)!;
          act(() => socket.onopen?.());
          act(() =>
            socket.onclose?.({
              code: 1008,
              reason: "Terminal not found.",
            } as CloseEvent)
          );
          await act(async () => {
            await vi.advanceTimersByTimeAsync(250);
          });
        };
        await loseSession();
        await loseSession();
        expect(Socket.instances).toHaveLength(3);
        if (confirmed) {
          act(() =>
            Socket.instances[2].onmessage?.({
              data: JSON.stringify({ type: "connected" }),
            } as MessageEvent)
          );
          await loseSession();
          await loseSession();
          expect(Socket.instances).toHaveLength(5);
        }
        await loseSession();
        expect(screen.getByRole("status").textContent).toBe("Unavailable");
        expect(
          screen.getByRole("button", { name: "Retry connection" })
        ).toBeTruthy();
        expect(
          sessionStorage.getItem("dispatch:human-terminal:agent")
        ).toBeNull();
        expect(fetch).toHaveBeenCalledTimes(confirmed ? 5 : 3);
        for (const [, options] of fetch.mock.calls.slice(1)) {
          expect(JSON.parse(options.body).terminalId).toBeUndefined();
        }
      } finally {
        vi.useRealTimers();
      }
    }
  );
  it.each([404, 503])(
    "handles End response %s without losing recovery",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce({ ok: true, json: async () => info })
          .mockResolvedValueOnce({
            ok: false,
            status,
            json: async () => ({ error: "Terminal unavailable." }),
          })
      );
      render(<TerminalPanel agentId="agent" active />);
      await waitFor(() => expect(Socket.instances).toHaveLength(1));
      act(() => Socket.instances[0].onopen?.());
      fireEvent.click(screen.getByRole("button", { name: "End terminal" }));
      await waitFor(() =>
        expect(screen.getByRole("status").textContent).toBe(
          status === 404 ? "Ended" : "End failed"
        )
      );
      expect(
        screen.getByRole("button", {
          name: status === 404 ? "New terminal" : "Retry End",
        })
      ).toBeTruthy();
      expect(screen.queryByLabelText("Host terminal")).toBeNull();
      const saved = sessionStorage.getItem("dispatch:human-terminal:agent")!;
      if (status === 404) expect(saved).toBe("stopped");
      else
        expect(JSON.parse(saved)).toMatchObject({
          stop: info.id,
          error: "Terminal unavailable.",
        });
    }
  );
  it.each([false, true])(
    "does not resume a pending End after remount (failure=%s)",
    async (failure) => {
      let resolveEnd!: (value: unknown) => void;
      const fetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => info })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveEnd = resolve;
            })
        )
        .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
      vi.stubGlobal("fetch", fetch);
      const first = render(<TerminalPanel agentId="agent" active />);
      await waitFor(() => expect(Socket.instances).toHaveLength(1));
      act(() => Socket.instances[0].onopen?.());
      fireEvent.click(screen.getByRole("button", { name: "End terminal" }));
      expect(
        JSON.parse(sessionStorage.getItem("dispatch:human-terminal:agent")!)
      ).toMatchObject({ stop: info.id });
      // DELETE has removed the shell, but its response has not arrived yet.
      first.unmount();
      render(<TerminalPanel agentId="agent" active />);
      expect(screen.getByRole("status").textContent).toBe("End pending");
      expect(screen.getByRole("button", { name: "Retry End" })).toBeTruthy();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(Socket.instances).toHaveLength(1);
      await act(async () =>
        resolveEnd(
          failure
            ? {
                ok: false,
                status: 503,
                json: async () => ({ error: "Try again." }),
              }
            : { ok: true, json: async () => ({ ok: true }) }
        )
      );
      if (failure) {
        expect(screen.getByRole("status").textContent).toBe("End failed");
        expect(screen.getByRole("alert").textContent).toBe("Try again.");
        fireEvent.click(screen.getByRole("button", { name: "Retry End" }));
        await waitFor(() =>
          expect(screen.getByRole("status").textContent).toBe("Ended")
        );
        expect(fetch.mock.calls[2][0]).toBe(
          "/api/v1/human-terminals/terminal-id"
        );
        expect(fetch.mock.calls[2][1].method).toBe("DELETE");
      }
      expect(screen.getByRole("status").textContent).toBe("Ended");
      expect(sessionStorage.getItem("dispatch:human-terminal:agent")).toBe(
        "stopped"
      );
      expect(fetch).toHaveBeenCalledTimes(failure ? 3 : 2);
    }
  );
  it.each([false, true])(
    "ignores stale End settlement after remount, retry, and New terminal (failure=%s)",
    async (failure) => {
      let resolveEnd!: (value: unknown) => void;
      const fetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => info })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveEnd = resolve;
            })
        )
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          json: async () => ({ error: "Already deleted." }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ ...info, id: "new-terminal" }),
        });
      vi.stubGlobal("fetch", fetch);
      const first = render(<TerminalPanel agentId="agent" active />);
      await waitFor(() => expect(Socket.instances).toHaveLength(1));
      act(() => Socket.instances[0].onopen?.());
      fireEvent.click(screen.getByRole("button", { name: "End terminal" }));
      first.unmount();
      render(<TerminalPanel agentId="agent" active />);
      expect(fetch).toHaveBeenCalledTimes(2);
      fireEvent.click(screen.getByRole("button", { name: "Retry End" }));
      await screen.findByRole("button", { name: "New terminal" });
      fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
      await waitFor(() => expect(Socket.instances).toHaveLength(2));
      act(() => Socket.instances[1].onopen?.());
      await act(async () =>
        resolveEnd(
          failure
            ? {
                ok: false,
                status: 503,
                json: async () => ({ error: "Late failure." }),
              }
            : { ok: true, json: async () => ({ ok: true }) }
        )
      );
      expect(screen.getByRole("status").textContent).toBe("Connected");
      expect(sessionStorage.getItem("dispatch:human-terminal:agent")).toBe(
        "new-terminal"
      );
      expect(screen.queryByRole("alert")).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(4);
    }
  );
  it("keeps its shell connection while hidden and ends through a bodyless DELETE", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => info })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetch);
    const props = { agentId: "agent" };
    const { rerender } = render(<TerminalPanel {...props} active />);
    await waitFor(() => expect(Socket.instances).toHaveLength(1));
    act(() => Socket.instances[0].onopen?.());
    expect(screen.getByRole("status").textContent).toBe("Connected");
    rerender(<TerminalPanel {...props} active={false} />);
    expect(Socket.instances[0].close).not.toHaveBeenCalled();
    rerender(<TerminalPanel {...props} active />);
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
    render(<TerminalPanel agentId="agent" active />);
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
    sessionStorage.setItem("dispatch:human-terminal:agent", "stopped");
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => info });
    vi.stubGlobal("fetch", fetch);
    render(<TerminalPanel agentId="agent" active />);
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
    render(<TerminalPanel agentId="agent" active />);
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
    render(<TerminalPanel agentId="agent" active />);
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
      <TerminalPanel key="first" agentId="first" active />
    );
    rerender(<TerminalPanel key="second" agentId="second" active />);
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
    render(<TerminalPanel agentId="agent" active />);
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
