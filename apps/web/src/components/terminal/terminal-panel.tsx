import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";
import { createClientId } from "@/lib/client-id";

type Info = {
  id: string;
  host: string;
  user: string;
  cwd: string;
  unencrypted: boolean;
};
type Stream = {
  replay: Uint8Array;
  write?: (data: Uint8Array) => void;
  socket: WebSocket | null;
  cols?: number;
  rows?: number;
};
const MAX_REPLAY = 256 * 1024;
const STATUS_LABELS = {
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Disconnected — reconnecting",
  connectionFailed: "Connection failed",
  unavailable: "Unavailable",
  ending: "Ending",
  ended: "Ended",
  endFailed: "End failed",
} as const;
type Status = keyof typeof STATUS_LABELS | { exitCode: number };

function sessionKey(agentId: string) {
  return `dispatch:human-terminal:${agentId}`;
}
function saveSession(agentId: string, value: string | null) {
  const key = sessionKey(agentId);
  if (value === null) sessionStorage.removeItem(key);
  else sessionStorage.setItem(key, value);
}
function readSession(agentId: string) {
  const value = sessionStorage.getItem(sessionKey(agentId));
  // Older builds used this marker for lost sessions as well as user stops.
  if (value === "ended") {
    saveSession(agentId, null);
    return null;
  }
  return value;
}
function clientId() {
  const key = "dispatch:human-terminal-client";
  let value = sessionStorage.getItem(key);
  if (!value) {
    value = createClientId();
    sessionStorage.setItem(key, value);
  }
  return value;
}
async function request(path: string, method: string, body?: object) {
  const response = await fetch(`/api/v1/human-terminals${path}`, {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(result.error || "Terminal request failed."), {
      status: response.status,
    });
  return result;
}

function TerminalCanvas({
  stream,
  active,
}: {
  stream: Stream;
  active: boolean;
}) {
  const instance = useRef<{ terminal: Terminal; fit: FitAddon } | null>(null);
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!element.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      scrollback: 2000,
      fontSize: 13,
      theme: { background: "#101014" },
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element.current);
    instance.current = { terminal, fit };
    terminal.write(stream.replay);
    stream.write = (data) => terminal.write(data);
    const send = (message: object) => {
      if (stream.socket?.readyState === WebSocket.OPEN)
        stream.socket.send(JSON.stringify(message));
    };
    const input = terminal.onData((data) => send({ type: "input", data }));
    const resize = terminal.onResize(({ cols, rows }) => {
      stream.cols = cols;
      stream.rows = rows;
      send({ type: "resize", cols, rows });
    });
    const observer = new ResizeObserver(() => {
      if (!element.current?.getClientRects().length) return;
      fit.fit();
      send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
    });
    observer.observe(element.current);

    return () => {
      instance.current = null;
      stream.write = undefined;
      observer.disconnect();
      input.dispose();
      resize.dispose();
      terminal.dispose();
    };
  }, [stream]);
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      instance.current?.fit.fit();
      instance.current?.terminal.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);
  return (
    <div
      ref={element}
      className="min-h-0 flex-1 overflow-hidden rounded bg-[#101014] p-2"
      aria-label="Host terminal"
    />
  );
}

export default function TerminalPanel({
  agentId,
  active,
}: {
  agentId: string;
  active: boolean;
}) {
  const [info, setInfo] = useState<Info | null>(null);
  const [status, setStatus] = useState<Status>(() =>
    readSession(agentId) === "stopped" ? "ended" : "connecting"
  );
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const stream = useRef<Stream>({
    replay: new Uint8Array(),
    socket: null,
  }).current;
  const ended = useRef(false);
  const stopConnection = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | undefined;
    let missingSessionRetries = 0;
    if (readSession(agentId) === "stopped") return;
    ended.current = false;
    setStatus("connecting");
    setError(null);
    const disconnect = () => {
      cancelled = true;
      clearTimeout(retry);
      socket?.close();
      stream.socket = null;
    };
    stopConnection.current = disconnect;
    const markStopped = () => {
      ended.current = true;
      saveSession(agentId, "stopped");
      stream.socket = null;
    };
    function reconnectAfter(delay: number) {
      retry = setTimeout(() => {
        if (!cancelled && !ended.current) void connect();
      }, delay);
    }
    async function connect() {
      try {
        const terminalId = readSession(agentId) ?? undefined;
        let result: Info;
        try {
          result = await request("", "POST", {
            agentId,
            clientId: clientId(),
            terminalId,
          });
        } catch (cause) {
          if (cancelled || ended.current) return;
          if (!terminalId || (cause as { status?: number }).status !== 404)
            throw cause;
          saveSession(agentId, null);
          result = await request("", "POST", { agentId, clientId: clientId() });
        }
        if (cancelled || ended.current) return;
        saveSession(agentId, result.id);
        setInfo(result);
        setError(null);
        const url = new URL(
          `/api/v1/human-terminals/${result.id}/socket`,
          location.href
        );
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        socket = new WebSocket(url);
        socket.binaryType = "arraybuffer";
        stream.socket = socket;
        socket.onopen = () => {
          if (cancelled || ended.current) {
            socket?.close();
            return;
          }
          stream.replay = new Uint8Array();
          stream.write?.(new TextEncoder().encode("\x1bc"));
          setStatus("connected");
          if (stream.cols && stream.rows)
            socket?.send(
              JSON.stringify({
                type: "resize",
                cols: stream.cols,
                rows: stream.rows,
              })
            );
        };
        socket.onmessage = (event) => {
          if (cancelled || ended.current) return;
          if (typeof event.data === "string") {
            const message = JSON.parse(event.data);
            if (message.type === "connected") missingSessionRetries = 0;
            if (message.type === "exit") {
              markStopped();
              setStatus({ exitCode: message.code });
            }
            return;
          }
          const data = new Uint8Array(event.data);
          const combined = new Uint8Array(stream.replay.length + data.length);
          combined.set(stream.replay);
          combined.set(data, stream.replay.length);
          stream.replay = combined.slice(-MAX_REPLAY);
          stream.write?.(data);
        };
        socket.onclose = (event) => {
          if (cancelled || ended.current) return;
          if (event.code === 1008 && event.reason === "Terminal not found.") {
            // The shell can expire between the resume request and WS attach.
            // Losing it is not the same as the user deliberately ending it.
            saveSession(agentId, null);
            stream.socket = null;
            setError(null);
            if (missingSessionRetries++ < 2) {
              setStatus("connecting");
              reconnectAfter(250);
            } else {
              setStatus("unavailable");
              setError("Could not reconnect to the host. Try again.");
            }
            return;
          }
          if (
            event.code === 1000 ||
            event.code === 1008 ||
            event.code === 4001
          ) {
            markStopped();
            setStatus("ended");
            setError(event.reason || "Terminal connection ended.");
            return;
          }
          setStatus("reconnecting");
          reconnectAfter(2000);
        };
        socket.onerror = () => {
          if (!cancelled && !ended.current) setStatus("connectionFailed");
        };
      } catch (cause) {
        if (!cancelled && !ended.current) {
          setStatus("unavailable");
          setError(
            cause instanceof Error ? cause.message : "Cannot open terminal."
          );
        }
      }
    }
    void connect();
    return disconnect;
  }, [agentId, generation, stream]);

  const end = useCallback(async () => {
    const current = info;
    if (!current) return;
    ended.current = true;
    stopConnection.current();
    setStatus("ending");
    setError(null);
    try {
      try {
        await request(`/${current.id}`, "DELETE");
      } catch (cause) {
        // An exited or expired shell has already reached the desired state.
        if ((cause as { status?: number }).status !== 404) throw cause;
      }
      saveSession(agentId, "stopped");
      setStatus("ended");
      setError(null);
    } catch (cause) {
      setStatus("endFailed");
      setError(cause instanceof Error ? cause.message : "Cannot end terminal.");
    }
  }, [agentId, info]);

  const ready = status === "connected";
  const finished = status === "ended" || typeof status === "object";
  const statusLabel =
    typeof status === "object"
      ? `Exited (${status.exitCode})`
      : STATUS_LABELS[status];
  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-2 p-3"
      aria-label="Terminal"
      data-hotkey-disable="true"
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
      }}
    >
      <div className="min-w-0 text-xs text-muted-foreground">
        <p
          className="truncate"
          title={info ? `${info.user}@${info.host}` : undefined}
        >
          {info ? `${info.user}@${info.host}` : "Dispatch host"}
        </p>
        {info && (
          <p className="truncate" title={info.cwd}>
            {info.cwd}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span role="status" className="mr-auto">
          {statusLabel}
        </span>
        {info && !finished && (
          <Button
            variant="default"
            size="sm"
            disabled={status === "ending"}
            onClick={() => void end()}
          >
            {status === "endFailed" ? "Retry End" : "End terminal"}
          </Button>
        )}
        {finished && (
          <Button
            size="sm"
            onClick={() => {
              saveSession(agentId, null);
              setInfo(null);
              stream.replay = new Uint8Array();
              setGeneration((value) => value + 1);
            }}
          >
            New terminal
          </Button>
        )}
        {status === "unavailable" && (
          <Button size="sm" onClick={() => setGeneration((value) => value + 1)}>
            Retry connection
          </Button>
        )}
      </div>
      {info?.unencrypted && (
        <p className="text-xs text-amber-500">
          Unencrypted connection on this network.
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {ready ? (
        <TerminalCanvas stream={stream} active={active} />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center rounded bg-[#101014] p-4 text-center text-xs text-muted-foreground">
          {finished
            ? "Choose New terminal to open a shell."
            : status === "unavailable" || status === "endFailed"
              ? "Terminal unavailable."
              : status === "ending"
                ? "Ending your shell…"
                : "Connecting to your shell…"}
        </div>
      )}
    </section>
  );
}
