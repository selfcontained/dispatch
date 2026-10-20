import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
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
  if (!response.ok) throw new Error(result.error || "Terminal request failed.");
  return result;
}

function TerminalCanvas({ stream }: { stream: Stream }) {
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
      fit.fit();
      send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
    });
    observer.observe(element.current);
    terminal.focus();
    return () => {
      stream.write = undefined;
      observer.disconnect();
      input.dispose();
      resize.dispose();
      terminal.dispose();
    };
  }, [stream]);
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
  open,
  onOpenChange,
}: {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [info, setInfo] = useState<Info | null>(null);
  const [status, setStatus] = useState("Connecting");
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
    ended.current = false;
    stopConnection.current = () => {
      cancelled = true;
      clearTimeout(retry);
      socket?.close();
      stream.socket = null;
    };
    async function connect() {
      try {
        const result: Info = await request("", "POST", {
          agentId,
          clientId: clientId(),
          terminalId:
            sessionStorage.getItem(`dispatch:human-terminal:${agentId}`) ||
            undefined,
        });
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
            if (message.type === "exit") {
              ended.current = true;
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
          if (
            event.code === 1000 ||
            event.code === 1008 ||
            event.code === 4001
          ) {
            ended.current = true;
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
    try {
      await request(`/${current.id}`, "DELETE");
      ended.current = true;
      stopConnection.current();
      setStatus("Ended");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Cannot end terminal.");
    }
  }, []);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        onOpenAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (event.target instanceof Element && event.target.closest(".xterm"))
            event.preventDefault();
        }}
      >
        <SheetTitle className="pr-8 text-lg font-semibold">Terminal</SheetTitle>
        <SheetDescription className="break-all text-xs text-muted-foreground">
          {info
            ? `${info.user}@${info.host} · ${info.cwd}`
            : "Interactive shell on the Dispatch host"}
        </SheetDescription>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span role="status">{status}</span>
          <Button
            className="ml-auto"
            variant="default"
            size="sm"
            onClick={() => void end()}
            disabled={
              !info || status === "Ended" || status.startsWith("Exited")
            }
          >
            End terminal
          </Button>
          {(status === "Unavailable" ||
            status === "Ended" ||
            status.startsWith("Exited")) && (
            <Button
              size="sm"
              variant="default"
              onClick={() => {
                sessionStorage.removeItem(`dispatch:human-terminal:${agentId}`);
                setGeneration((value) => value + 1);
              }}
            >
              Start terminal
            </Button>
          )}
        </div>
        {info?.unencrypted && (
          <p className="text-xs text-amber-500">
            Unencrypted HTTP connection. Terminal traffic is visible on this
            network.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <TerminalCanvas stream={stream} />
      </SheetContent>
    </Sheet>
  );
}
