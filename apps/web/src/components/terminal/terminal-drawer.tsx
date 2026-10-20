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

export default function TerminalDrawer({
  agentId,
  active,
}: {
  agentId: string;
  active: boolean;
}) {
  const [info, setInfo] = useState<Info | null>(null);
  const [status, setStatus] = useState(() =>
    sessionStorage.getItem(`dispatch:human-terminal:${agentId}`) === "stopped"
      ? "Ended"
      : "Connecting"
  );
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const stream = useRef<Stream>({
    replay: new Uint8Array(),
    socket: null,
  }).current;
  const ended = useRef(false);
  const infoRef = useRef<Info | null>(null);
  const stopConnection = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | undefined;
    let missingSessionRetries = 0;
    if (
      sessionStorage.getItem(`dispatch:human-terminal:${agentId}`) === "stopped"
    )
      return;
    ended.current = false;
    setStatus("Connecting");
    setError(null);
    stopConnection.current = () => {
      cancelled = true;
      clearTimeout(retry);
      socket?.close();
      stream.socket = null;
    };
    async function connect() {
      try {
        const key = `dispatch:human-terminal:${agentId}`;
        const storedId = sessionStorage.getItem(key);
        // Older builds used this marker for lost sessions as well as user stops.
        if (storedId === "ended") sessionStorage.removeItem(key);
        const terminalId =
          storedId && storedId !== "ended" ? storedId : undefined;
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
          sessionStorage.removeItem(key);
          result = await request("", "POST", { agentId, clientId: clientId() });
        }
        if (cancelled || ended.current) return;
        sessionStorage.setItem(`dispatch:human-terminal:${agentId}`, result.id);
        infoRef.current = result;
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
          setStatus("Connected");
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
              ended.current = true;
              sessionStorage.setItem(
                `dispatch:human-terminal:${agentId}`,
                "stopped"
              );
              stream.socket = null;
              setStatus(`Exited (${message.code})`);
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
            sessionStorage.removeItem(`dispatch:human-terminal:${agentId}`);
            stream.socket = null;
            setError(null);
            if (missingSessionRetries++ < 2) {
              setStatus("Connecting");
              retry = setTimeout(() => {
                if (!cancelled && !ended.current) void connect();
              }, 250);
            } else {
              setStatus("Unavailable");
              setError("Could not reconnect to the host. Try again.");
            }
            return;
          }
          if (
            event.code === 1000 ||
            event.code === 1008 ||
            event.code === 4001
          ) {
            ended.current = true;
            sessionStorage.setItem(
              `dispatch:human-terminal:${agentId}`,
              "stopped"
            );
            stream.socket = null;
            setStatus("Ended");
            setError(event.reason || "Terminal connection ended.");
            return;
          }
          setStatus("Disconnected — reconnecting");
          retry = setTimeout(() => {
            if (!cancelled && !ended.current) void connect();
          }, 2000);
        };
        socket.onerror = () => {
          if (!cancelled && !ended.current) setStatus("Connection failed");
        };
      } catch (cause) {
        if (!cancelled && !ended.current) {
          setStatus("Unavailable");
          setError(
            cause instanceof Error ? cause.message : "Cannot open terminal."
          );
        }
      }
    }
    void connect();
    return () => {
      cancelled = true;
      clearTimeout(retry);
      socket?.close();
      stream.socket = null;
    };
  }, [agentId, generation, stream]);

  const end = useCallback(async () => {
    const current = infoRef.current;
    if (!current) return;
    ended.current = true;
    stopConnection.current();
    setStatus("Ending");
    setError(null);
    try {
      try {
        await request(`/${current.id}`, "DELETE");
      } catch (cause) {
        // An exited or expired shell has already reached the desired state.
        if ((cause as { status?: number }).status !== 404) throw cause;
      }
      sessionStorage.setItem(`dispatch:human-terminal:${agentId}`, "stopped");
      setStatus("Ended");
      setError(null);
    } catch (cause) {
      setStatus("End failed");
      setError(cause instanceof Error ? cause.message : "Cannot end terminal.");
    }
  }, [agentId]);

  const ready = status === "Connected";
  const finished = status === "Ended" || status.startsWith("Exited");
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
          {status}
        </span>
        {info && !finished && (
          <Button
            variant="default"
            size="sm"
            disabled={status === "Ending"}
            onClick={() => void end()}
          >
            {status === "End failed" ? "Retry End" : "End terminal"}
          </Button>
        )}
        {finished && (
          <Button
            size="sm"
            onClick={() => {
              sessionStorage.removeItem(`dispatch:human-terminal:${agentId}`);
              infoRef.current = null;
              setInfo(null);
              stream.replay = new Uint8Array();
              setGeneration((value) => value + 1);
            }}
          >
            New terminal
          </Button>
        )}
        {status === "Unavailable" && (
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
            : status === "Unavailable" || status === "End failed"
              ? "Terminal unavailable."
              : status === "Ending"
                ? "Ending your shell…"
                : "Connecting to your shell…"}
        </div>
      )}
    </section>
  );
}
