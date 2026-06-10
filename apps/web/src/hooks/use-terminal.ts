import {
  type MutableRefObject,
  type RefCallback,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  type Agent,
  type AuthState,
  type ConnState,
  type TerminalCopyMode,
  type TerminalUiState,
} from "@/components/app/types";
import { api } from "@/lib/api";
import { toast } from "sonner";

import { isAcceptedUploadFile, uploadAgentMedia } from "@/lib/media-upload";
import { useSystemDefaults } from "@/hooks/use-system-defaults";
import { recordWSReconnect } from "@/lib/energy-metrics";
import { type ThemeId, getTerminalPalette } from "@/hooks/use-theme";
import {
  RESUME_RECONNECT_DEDUPE_MS,
  clearSocketHealth,
  createSocketHealth,
  isRetriableTerminalFailure,
  isSocketFresh,
  isTerminalSessionGone,
  markSocketHealthy,
  noteSocketError,
  openTerminalSocket,
  probeTerminalSocket,
} from "@/hooks/terminal-socket";
import { createTerminalSurface } from "@/hooks/terminal-surface";

function focusTerminalSurface(term: XTerm | null): void {
  if (!term) return;
  term.focus();
  requestAnimationFrame(() => {
    term.focus();
    window.setTimeout(() => {
      term.focus();
    }, 0);
  });
}

export function useTerminal(args: {
  authState: AuthState;
  agents: Agent[];
  selectedAgentId: string | null;
  theme: ThemeId;
  isMobile: boolean;
  leftOpen: boolean;
  deferMediaResize: boolean;
  mediaResizeSettleKey: number;
  feedbackOpen: boolean;
}): {
  connState: ConnState;
  connectedAgentId: string | null;
  terminalMode: "tmux" | "inert" | null;
  terminalPlaceholderMessage: string | null;
  inCopyMode: boolean;
  copyMode: TerminalCopyMode | "unknown";
  statusMessage: string;
  terminalHostRef: RefCallback<HTMLDivElement>;
  ctrlPendingRef: MutableRefObject<boolean>;
  focusTerminal: () => void;
  ensureTerminalConnected: (
    clearScreen?: boolean,
    userInitiated?: boolean,
    targetAgentId?: string
  ) => Promise<void>;
  detachTerminal: () => void;
  sendTerminalInput: (data: string) => void;
  exitCopyMode: () => Promise<void>;
  resyncing: boolean;
  draggingFiles: boolean;
  uploadingFiles: boolean;
} {
  const {
    authState,
    agents,
    selectedAgentId,
    theme,
    isMobile,
    leftOpen,
    deferMediaResize,
    mediaResizeSettleKey,
    feedbackOpen,
  } = args;
  const queryClient = useQueryClient();

  const [connState, setConnState] = useState<ConnState>("disconnected");
  const [connectedAgentId, setConnectedAgentId] = useState<string | null>(null);
  const [terminalMode, setTerminalMode] = useState<"tmux" | "inert" | null>(
    null
  );
  const [terminalPlaceholderMessage, setTerminalPlaceholderMessage] = useState<
    string | null
  >(null);
  const [exitPending, setExitPending] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Starting...");
  // True while requestFit's auto-RESYNC is in flight. Lets the UI show a
  // calm "Resizing…" overlay instead of the empty / reconnect overlays
  // that the underlying detach → reattach transition would otherwise expose.
  const [resyncing, setResyncing] = useState(false);
  // True while a file is being dragged over the terminal, so the UI can show a
  // "Drop files to upload" overlay.
  const [draggingFiles, setDraggingFiles] = useState(false);
  // True while dropped/pasted files are being uploaded, so the UI can show a
  // loading indicator.
  const [uploadingFiles, setUploadingFiles] = useState(false);

  const connectedAgentIdRef = useRef<string | null>(null);
  connectedAgentIdRef.current = connectedAgentId;
  // Per-agent `[File #N]` sequence for dropped/pasted uploads. Monotonic per
  // agent within a mount and kept across agent switches (a Map keyed by
  // agentId), so it keeps incrementing across separate drops. N is a cosmetic
  // label, not a stable identifier — the CLI opens `media.path`, not the number
  // — and the ref resets if the terminal subtree remounts (route teardown / full
  // reconnect), so a number can repeat for an agent across remounts. That's an
  // accepted tradeoff; cross-mount stability isn't worth persisting a label.
  const fileSeqRef = useRef<Map<string, number>>(new Map());

  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const [terminalHostElement, setTerminalHostElement] =
    useState<HTMLDivElement | null>(null);
  const setTerminalHostRef = useCallback((node: HTMLDivElement | null) => {
    terminalHostRef.current = node;
    setTerminalHostElement(node);
  }, []);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const fitDebounceRef = useRef<number | null>(null);
  const ctrlPendingRef = useRef(false);
  const copyModeRef = useRef<TerminalCopyMode | "unknown">("live");
  const exitCopyModeRef = useRef<() => Promise<void>>(async () => {});
  const noteScrollInteractionRef = useRef<() => void>(() => {});
  // Filled in via effect once detachTerminal/ensureTerminalConnected exist —
  // lets requestFit trigger an auto-RESYNC without needing those defined
  // earlier in the hook body.
  const resyncOnResizeRef = useRef<() => void>(() => {});
  // Filled in below; let the terminal surface's drag/drop + paste handlers call
  // the latest logic without re-creating the terminal when the callback changes.
  const uploadAndInsertFilesRef = useRef<(files: File[]) => void>(() => {});
  const pasteImageRef = useRef<(file: File) => void>(() => {});
  // Whether the host can place a pasted image on a clipboard the agent CLI can
  // read (macOS pasteboard / Linux+Xvfb). Populated from /system/defaults; until
  // then we conservatively fall back to path-based paste.
  const clipboardCapableRef = useRef(false);

  const wsRef = useRef<WebSocket | null>(null);
  const shouldKeepAttachedRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const attachNonceRef = useRef(0);
  const reconnectInFlightRef = useRef<{
    agentId: string;
    promise: Promise<void>;
  } | null>(null);
  const lastResumeTriggerAtRef = useRef(0);
  const socketHealthRef = useRef(createSocketHealth());

  // Ref for agents so ensureTerminalConnected doesn't get recreated on every
  // SSE-driven agents array update (which would trigger the visibility/focus
  // effect and cause spurious reconnect attempts that abort in-flight connects).
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const deferMediaResizeRef = useRef(deferMediaResize);
  deferMediaResizeRef.current = deferMediaResize;
  const lastInteractionHintAtRef = useRef(0);

  const { data: terminalState } = useQuery<TerminalUiState>({
    queryKey: ["terminal-state", connectedAgentId],
    queryFn: async () => {
      if (!connectedAgentId) {
        return { copyMode: "live", lastObservedAt: 0 };
      }
      const payload = await api<{ terminalState: TerminalUiState }>(
        `/api/v1/agents/${connectedAgentId}/terminal/state`
      );
      return payload.terminalState;
    },
    enabled:
      terminalMode === "tmux" &&
      connState === "connected" &&
      connectedAgentId !== null,
    refetchOnWindowFocus: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const serverCopyMode =
    terminalMode !== "tmux" ? "live" : (terminalState?.copyMode ?? "unknown");
  const copyMode: TerminalCopyMode | "unknown" =
    exitPending &&
    (serverCopyMode === "unknown" || serverCopyMode === "exiting")
      ? "exiting"
      : serverCopyMode;
  copyModeRef.current = copyMode;

  const sendResize = useCallback(() => {
    const ws = wsRef.current;
    const term = terminalRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !term) return;
    ws.send(
      JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })
    );
  }, []);

  // Trailing-debounced size-change detector. ResizeObserver and CSS
  // transitions can fire many size changes per visual settle; we wait 300ms
  // for the host to stop moving, then ask the fit addon what cols/rows it
  // would propose. If they differ from xterm's current dims, we full-RESYNC
  // (tear down the WebSocket and re-attach with the new size in the URL).
  //
  // Why RESYNC instead of just calling fit()? xterm's destructive resize
  // leaves stale state behind — cursor saves, scroll regions, app modes,
  // scrollback rows wrapped at the old cols — that the agent's incremental
  // redraws after SIGWINCH can't fully overwrite. Subsequent positioned
  // writes start landing wrong as new bytes arrive. A reattach pulls a
  // fresh viewport from tmux into a clean buffer, same as a page reload.
  const requestFit = useCallback(() => {
    if (fitDebounceRef.current !== null) {
      window.clearTimeout(fitDebounceRef.current);
    }
    fitDebounceRef.current = window.setTimeout(() => {
      fitDebounceRef.current = null;
      const term = terminalRef.current;
      const fit = fitAddonRef.current;
      if (!term || !fit) return;
      const proposed = fit.proposeDimensions();
      if (!proposed) return;
      if (proposed.cols === term.cols && proposed.rows === term.rows) return;
      resyncOnResizeRef.current();
    }, 300);
  }, []);

  const resetTerminalState = useCallback(() => {
    setExitPending(false);
  }, []);

  const hasFreshSocket = useCallback((agentId: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    if (connectedAgentIdRef.current !== agentId) return false;
    return isSocketFresh(socketHealthRef.current);
  }, []);

  const probeSocket = useCallback((agentId: string): Promise<boolean> => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve(false);
    if (connectedAgentIdRef.current !== agentId) return Promise.resolve(false);
    const term = terminalRef.current;
    if (!term) return Promise.resolve(false);
    return probeTerminalSocket(ws, term.cols, term.rows, () =>
      markSocketHealthy(socketHealthRef.current, "heartbeat")
    );
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const invalidateAttachAttempt = useCallback(() => {
    attachNonceRef.current += 1;
  }, []);

  const resetTerminalSurface = useCallback(() => {
    const term = terminalRef.current;
    if (!term) return;
    term.reset();
    term.clear();
  }, []);

  const closeSocketTransport = useCallback(() => {
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }
    clearSocketHealth(socketHealthRef.current);
  }, []);

  const restoreConnectedState = useCallback(
    (agent: Agent, mode: "tmux" | "inert", message?: string) => {
      clearReconnectTimer();
      reconnectAttemptsRef.current = 0;
      setConnState("connected");
      setConnectedAgentId(agent.id);
      setTerminalMode(mode);
      setTerminalPlaceholderMessage(mode === "tmux" ? null : (message ?? null));
      setStatusMessage(message ?? `Connected to session ${agent.name}`);
    },
    [clearReconnectTimer]
  );

  const closeSocket = useCallback(
    (announce = true) => {
      closeSocketTransport();
      resetTerminalState();
      setConnectedAgentId(null);
      setTerminalMode(null);
      setTerminalPlaceholderMessage(null);

      if (announce) {
        setStatusMessage("Session disconnected.");
        setConnState("disconnected");
      }
    },
    [closeSocketTransport, resetTerminalState]
  );

  const ensureTerminalConnected = useCallback(
    async (
      clearScreen = false,
      userInitiated = false,
      targetAgentId?: string
    ) => {
      if (userInitiated) {
        shouldKeepAttachedRef.current = true;
      }

      const resolvedAgentId = targetAgentId ?? selectedAgentId;
      if (!shouldKeepAttachedRef.current || !resolvedAgentId) return;

      if (
        !userInitiated &&
        reconnectInFlightRef.current?.agentId === resolvedAgentId
      ) {
        await reconnectInFlightRef.current.promise;
        return;
      }

      // Nonce is incremented later (just before opening a new WebSocket) so
      // that reusing a fresh socket doesn't invalidate its existing message
      // handler.  Read the current value here for the in-flight guard only.
      let attemptNonce = attachNonceRef.current;
      const isCurrentAttempt = () =>
        shouldKeepAttachedRef.current &&
        attemptNonce === attachNonceRef.current;

      const scheduleReconnect = (message: string) => {
        if (!isCurrentAttempt() || !shouldKeepAttachedRef.current) {
          return;
        }

        reconnectAttemptsRef.current += 1;
        recordWSReconnect();
        const delay = Math.min(1200 * reconnectAttemptsRef.current, 8000);
        setConnState("reconnecting");
        setStatusMessage(message);
        clearReconnectTimer();
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          if (!shouldKeepAttachedRef.current || document.hidden) return;
          void ensureTerminalConnected(false, false, resolvedAgentId);
        }, delay);
      };

      const connectPromise = (async () => {
        let agent: Agent | null = userInitiated
          ? (agentsRef.current.find((item) => item.id === resolvedAgentId) ??
            null)
          : null;

        if (!agent || agent.status !== "running") {
          try {
            const payload = await api<{ agent: Agent }>(
              `/api/v1/agents/${resolvedAgentId}?includeGitContext=false`
            );
            agent = payload.agent;
          } catch {
            if (!isCurrentAttempt()) return;
            scheduleReconnect("Session disconnected, reconnecting...");
            return;
          }
        }

        if (!isCurrentAttempt() || !agent) return;

        if (agent.status !== "running" && agent.status !== "creating") {
          shouldKeepAttachedRef.current = false;
          clearReconnectTimer();
          closeSocket(false);
          resetTerminalSurface();
          setConnState("disconnected");
          setStatusMessage("Session ended.");
          return;
        }

        if (hasFreshSocket(agent.id)) {
          restoreConnectedState(agent, "tmux");
          sendResize();
          return;
        }

        // Socket is open but stale (no heartbeat during background throttle).
        // Probe it before tearing down — avoids a full reconnect cycle.
        if (
          wsRef.current?.readyState === WebSocket.OPEN &&
          connectedAgentIdRef.current === agent.id
        ) {
          const alive = await probeSocket(agent.id);
          if (!isCurrentAttempt()) return;
          if (alive) {
            restoreConnectedState(agent, "tmux");
            sendResize();
            return;
          }
        }

        // We're about to create a new WebSocket — NOW increment the nonce to
        // invalidate any previous handler that is still attached.
        attemptNonce = ++attachNonceRef.current;

        if (
          wsRef.current &&
          wsRef.current.readyState === WebSocket.OPEN &&
          connectedAgentIdRef.current === agent.id
        ) {
          closeSocketTransport();
        }

        clearReconnectTimer();
        closeSocket(false);
        resetTerminalSurface();

        if (clearScreen) {
          terminalRef.current?.clear();
        }

        fitAddonRef.current?.fit();
        setConnState("reconnecting");
        setStatusMessage(`Connecting to session ${agent.name}...`);

        try {
          const terminalSession = await api<
            | { mode: "tmux"; token: string; wsUrl: string }
            | { mode: "inert"; message: string }
          >(`/api/v1/agents/${agent.id}/terminal/token`, {
            method: "POST",
            body: JSON.stringify({}),
          });

          if (!isCurrentAttempt()) {
            return;
          }

          if (terminalSession.mode === "inert") {
            resetTerminalState();
            restoreConnectedState(agent, "inert", terminalSession.message);
            return;
          }

          const term = terminalRef.current;
          const cols = term?.cols ?? 140;
          const rows = term?.rows ?? 42;
          setTerminalMode("tmux");
          setTerminalPlaceholderMessage(null);
          const ws = openTerminalSocket(
            terminalSession.wsUrl,
            cols,
            rows,
            {
              onOpen: () => {
                markSocketHealthy(socketHealthRef.current, "open");
                restoreConnectedState(agent, "tmux");
                focusTerminalSurface(terminalRef.current);
                void queryClient.invalidateQueries({
                  queryKey: ["terminal-state", agent.id],
                  exact: true,
                });
              },
              onHeartbeat: () =>
                markSocketHealthy(socketHealthRef.current, "heartbeat"),
              onOutput: (data) => {
                markSocketHealthy(socketHealthRef.current, "output");
                terminalRef.current?.write(data);
              },
              onError: (message) => {
                noteSocketError(socketHealthRef.current, message);
                setStatusMessage(`Session error: ${message}`);
                if (isTerminalSessionGone(message)) {
                  shouldKeepAttachedRef.current = false;
                }
              },
              onSessionEnd: () => {
                noteSocketError(socketHealthRef.current, "Session ended.");
                socketHealthRef.current.sessionGone = true;
                shouldKeepAttachedRef.current = false;
                setStatusMessage("Session ended.");
              },
              onClose: (event) => {
                wsRef.current = null;
                const lastErrorMessage =
                  socketHealthRef.current.lastErrorMessage;
                const sessionGone = socketHealthRef.current.sessionGone;
                clearSocketHealth(socketHealthRef.current);

                if (sessionGone) {
                  shouldKeepAttachedRef.current = false;
                  setConnectedAgentId(null);
                  setTerminalMode(null);
                  resetTerminalSurface();
                  setConnState("disconnected");
                  return;
                }

                if (
                  event.code === 1008 &&
                  lastErrorMessage &&
                  isRetriableTerminalFailure(lastErrorMessage)
                ) {
                  scheduleReconnect("Session token expired, retrying...");
                  return;
                }

                scheduleReconnect("Session disconnected, reconnecting...");
              },
            },
            () => wsRef.current !== ws || !isCurrentAttempt()
          );
          wsRef.current = ws;
        } catch (error) {
          if (!isCurrentAttempt()) {
            return;
          }

          const message =
            error instanceof Error
              ? error.message
              : "Session connection failed.";
          if (isTerminalSessionGone(message)) {
            shouldKeepAttachedRef.current = false;
            clearReconnectTimer();
            closeSocket(false);
            resetTerminalSurface();
            setConnState("disconnected");
            setStatusMessage(message);
            return;
          }

          scheduleReconnect(
            isRetriableTerminalFailure(message)
              ? "Session token expired, retrying..."
              : "Session connection failed, retrying..."
          );
        }
      })();

      reconnectInFlightRef.current = {
        agentId: resolvedAgentId,
        promise: connectPromise,
      };
      try {
        await connectPromise;
      } finally {
        if (reconnectInFlightRef.current?.promise === connectPromise) {
          reconnectInFlightRef.current = null;
        }
      }
    },
    [
      clearReconnectTimer,
      closeSocket,
      closeSocketTransport,
      hasFreshSocket,
      probeSocket,
      queryClient,
      resetTerminalState,
      resetTerminalSurface,
      restoreConnectedState,
      selectedAgentId,
      sendResize,
    ]
  );

  const detachTerminal = useCallback(() => {
    shouldKeepAttachedRef.current = false;
    invalidateAttachAttempt();
    clearReconnectTimer();
    closeSocket(false);
    resetTerminalSurface();
    setConnState("disconnected");
    setStatusMessage("Detached from session.");
  }, [
    clearReconnectTimer,
    closeSocket,
    invalidateAttachAttempt,
    resetTerminalSurface,
  ]);

  const sendTerminalInput = useCallback((data: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "input", data }));
    terminalRef.current?.focus();
  }, []);

  // Upload dropped/pasted files (images included) to the connected agent's
  // media store and reference them in the prompt as `[File #N] <path> ` so the
  // CLI can open them. N increments per file inserted into the agent's prompt
  // and persists across separate drops (per-agent, via fileSeqRef). Works for
  // every agent without any host-clipboard / X display dependency. Surfaces
  // failures and skips via toast so a deliberate drop never silently no-ops.
  const uploadAndInsertFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      const agentId = connectedAgentIdRef.current;
      if (!agentId) {
        toast.error("Connect to an agent before dropping files.");
        return;
      }
      const accepted = files.filter((file) => isAcceptedUploadFile(file.name));
      const skipped = files.filter((file) => !isAcceptedUploadFile(file.name));
      if (accepted.length === 0) {
        toast.error(
          files.length === 1
            ? `Unsupported file type: ${files[0].name}`
            : "None of the dropped files are a supported type."
        );
        return;
      }
      if (skipped.length > 0) {
        toast.info(
          `Skipped ${skipped.length} unsupported file${
            skipped.length > 1 ? "s" : ""
          }: ${skipped.map((file) => file.name).join(", ")}`
        );
      }
      setUploadingFiles(true);
      void (async () => {
        const failures: string[] = [];
        let misrouted = 0;
        try {
          for (const file of accepted) {
            try {
              const media = await uploadAgentMedia(agentId, file);
              // The upload targeted `agentId`, but sendTerminalInput always
              // writes to the currently-connected terminal. If the user
              // switched agents mid-upload, don't type this agent's path into a
              // different agent's prompt.
              if (connectedAgentIdRef.current !== agentId) {
                misrouted += 1;
                continue;
              }
              const seq = (fileSeqRef.current.get(agentId) ?? 0) + 1;
              fileSeqRef.current.set(agentId, seq);
              sendTerminalInput(`[File #${seq}] ${media.path} `);
            } catch (err) {
              console.warn(`Upload failed for ${file.name}:`, err);
              failures.push(file.name);
            }
          }
        } finally {
          setUploadingFiles(false);
        }
        if (failures.length > 0) {
          toast.error(
            failures.length === 1
              ? `Failed to upload ${failures[0]}.`
              : `Failed to upload ${failures.length} files.`
          );
        }
        if (misrouted > 0) {
          toast.info(
            `Switched agents — ${misrouted} uploaded file${
              misrouted > 1 ? "s were" : " was"
            } not added to the new prompt.`
          );
        }
      })();
    },
    [sendTerminalInput]
  );
  uploadAndInsertFilesRef.current = uploadAndInsertFiles;

  // Hybrid image paste (Cmd/Ctrl+V): when the host can put the image on a
  // clipboard the agent CLI can read, inject it natively (POST it to the host
  // clipboard, then send Ctrl+V so the CLI inserts its own [Image #N] inline);
  // otherwise — or if that fails — fall back to the path-based media upload.
  const pasteImage = useCallback(
    (file: File) => {
      const agentId = connectedAgentIdRef.current;
      if (!agentId) {
        toast.error("Connect to an agent before pasting.");
        return;
      }
      // Not capable — uploadAndInsertFiles owns the uploading indicator for the
      // whole fallback; we never touch it here.
      if (!clipboardCapableRef.current) {
        uploadAndInsertFiles([file]);
        return;
      }
      // The uploadingFiles flag has a single owner per phase: this IIFE owns it
      // for the native attempt and clears it on success; before delegating to
      // the path-based fallback we clear it and hand ownership to
      // uploadAndInsertFiles (which manages the flag over its own lifetime).
      // We never leave it set across the handoff.
      setUploadingFiles(true);
      void (async () => {
        try {
          const form = new FormData();
          form.append(
            "file",
            file,
            file.name ||
              `clipboard.${file.type === "image/jpeg" ? "jpg" : "png"}`
          );
          // Safety timeout so a wedged endpoint can't hang the paste.
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10_000);
          try {
            await api<{ ok: boolean }>("/api/v1/clipboard/image", {
              method: "POST",
              body: form,
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timeout);
          }
          // Native paste only makes sense for the agent we set the clipboard
          // for; if the user switched, fall back so the image isn't lost.
          if (connectedAgentIdRef.current === agentId) {
            sendTerminalInput("\x16"); // Ctrl+V — CLI inserts [Image #N]
            setUploadingFiles(false);
            return;
          }
          setUploadingFiles(false);
          uploadAndInsertFiles([file]);
        } catch (err) {
          console.warn("Native clipboard paste failed; using upload:", err);
          setUploadingFiles(false);
          uploadAndInsertFiles([file]);
        }
      })();
    },
    [sendTerminalInput, uploadAndInsertFiles]
  );
  pasteImageRef.current = pasteImage;

  // Whether the host supports native clipboard-image paste. Sourced from the
  // shared React Query hook (cached/deduped across the app) and mirrored into a
  // ref so the pasteImage callback can read it synchronously without resubscribing.
  const { data: systemDefaults } = useSystemDefaults();
  useEffect(() => {
    clipboardCapableRef.current = !!systemDefaults?.clipboardImagePaste;
  }, [systemDefaults]);

  const noteScrollInteraction = useCallback(() => {
    const agentId = connectedAgentIdRef.current;
    if (!agentId || terminalMode !== "tmux") {
      return;
    }
    const now = Date.now();
    if (now - lastInteractionHintAtRef.current < 300) {
      return;
    }
    lastInteractionHintAtRef.current = now;

    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "interaction", interaction: "scroll" }));
      return;
    }

    void api<null>(`/api/v1/agents/${agentId}/terminal/interaction`, {
      method: "POST",
      body: JSON.stringify({ interaction: "scroll" }),
    }).catch(() => {});
  }, [terminalMode]);

  const exitCopyMode = useCallback(async () => {
    const agentId = connectedAgentIdRef.current;
    if (!agentId || terminalMode !== "tmux" || copyMode === "live") {
      return;
    }

    setExitPending(true);
    copyModeRef.current = "exiting";
    terminalRef.current?.focus();
    requestAnimationFrame(() => {
      terminalRef.current?.focus();
    });
    try {
      await api<null>(`/api/v1/agents/${agentId}/terminal/copy-mode/exit`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    } catch (error) {
      setExitPending(false);
      throw error;
    }
  }, [copyMode, terminalMode]);
  exitCopyModeRef.current = exitCopyMode;
  noteScrollInteractionRef.current = noteScrollInteraction;

  // Keep a ref so the xterm init effect can read the current theme without
  // depending on it (we don't want to re-create the terminal on theme change).
  const themeRef = useRef(theme);
  themeRef.current = theme;

  // xterm initialization — imperative setup extracted to terminal-surface.ts.
  useEffect(() => {
    if (!terminalHostElement) return;
    return createTerminalSurface(
      terminalHostElement,
      themeRef.current,
      {
        terminalRef,
        fitAddonRef,
        fitDebounceRef,
        wsRef,
        ctrlPendingRef,
        noteScrollInteractionRef,
        deferMediaResizeRef,
        uploadAndInsertFilesRef,
        pasteImageRef,
      },
      { requestFit, invalidateAttachAttempt, setDraggingFiles }
    );
  }, [authState, invalidateAttachAttempt, requestFit, terminalHostElement]);

  // Reconnect on visibility/focus.
  useEffect(() => {
    if (
      terminalMode !== "tmux" ||
      serverCopyMode === "live" ||
      serverCopyMode === "copy"
    ) {
      setExitPending(false);
    }
  }, [serverCopyMode, terminalMode]);

  useEffect(() => {
    const requestForegroundReconnect = () => {
      const targetAgentId =
        connectedAgentIdRef.current ?? selectedAgentId ?? undefined;
      if (!targetAgentId) return;
      if (hasFreshSocket(targetAgentId)) return;
      const now = Date.now();
      if (now - lastResumeTriggerAtRef.current < RESUME_RECONNECT_DEDUPE_MS) {
        return;
      }
      lastResumeTriggerAtRef.current = now;
      void ensureTerminalConnected(false, false, targetAgentId);
    };

    // Re-focus the terminal when the window/tab is foregrounded so the user
    // can type immediately. Gated to avoid stealing focus from other inputs
    // (dialogs, search, sidebar fields) that the browser may have restored.
    const tryFocusTerminalOnForeground = () => {
      const term = terminalRef.current;
      const host = terminalHostRef.current;
      if (!term || !host) return;
      if (terminalMode !== "tmux") return;
      if (isMobile) return;
      if (copyModeRef.current === "copy") return;
      const active = document.activeElement;
      // Treat body / documentElement / null as "nothing else holds focus" —
      // some browsers report the root element instead of body when no
      // interactive control owns focus after the window is foregrounded.
      const focusElsewhere =
        active &&
        active !== document.body &&
        active !== document.documentElement &&
        !host.contains(active);
      if (focusElsewhere) return;
      focusTerminalSurface(term);
    };

    const onVisible = () => {
      if (!document.hidden) {
        requestForegroundReconnect();
        tryFocusTerminalOnForeground();
      }
    };

    const onFocus = () => {
      requestForegroundReconnect();
      tryFocusTerminalOnForeground();
    };

    const onOnline = () => {
      clearReconnectTimer();
      void ensureTerminalConnected(
        false,
        false,
        connectedAgentIdRef.current ?? selectedAgentId ?? undefined
      );
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
    };
  }, [
    clearReconnectTimer,
    ensureTerminalConnected,
    hasFreshSocket,
    isMobile,
    selectedAgentId,
    terminalMode,
  ]);

  // Fit on layout change. The actual fit is debounced and reads the host's
  // settled size, so we don't need a hand-tuned timer to "wait for" the CSS
  // transition — ResizeObserver will keep poking requestFit until it stops.
  useEffect(() => {
    if (isMobile) return;
    requestFit();
  }, [isMobile, leftOpen, feedbackOpen, requestFit]);

  // Media sidebar width animates; the deferMediaResize gate suppresses
  // ResizeObserver fits during the slide, then this effect kicks one off
  // once it settles.
  useEffect(() => {
    if (isMobile) return;
    if (deferMediaResize) return;
    requestFit();
  }, [deferMediaResize, isMobile, mediaResizeSettleKey, requestFit]);

  // Update terminal palette and reconnect when theme changes.
  const prevThemeRef = useRef(theme);
  useEffect(() => {
    if (prevThemeRef.current === theme) return;
    prevThemeRef.current = theme;

    // Update xterm palette in-place
    const term = terminalRef.current;
    if (term) {
      const palette = getTerminalPalette(theme);
      term.options.theme = palette;
      term.options.minimumContrastRatio = palette.minimumContrastRatio ?? 1;
    }

    // Reconnect so tmux re-sends viewport with the new palette colors
    if (connState !== "connected" || !connectedAgentId) return;
    const agentId = connectedAgentId;
    detachTerminal();
    const timer = window.setTimeout(() => {
      void ensureTerminalConnected(true, true, agentId);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [
    theme,
    connState,
    connectedAgentId,
    detachTerminal,
    ensureTerminalConnected,
  ]);

  const focusTerminal = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  // Wire requestFit's auto-RESYNC trigger to the actual detach/reconnect
  // pair now that they exist. Mirrors the manual RESYNC button flow.
  useEffect(() => {
    resyncOnResizeRef.current = () => {
      const agentId = connectedAgentIdRef.current;
      if (!agentId) return;
      setResyncing(true);
      detachTerminal();
      window.setTimeout(() => {
        void ensureTerminalConnected(true, true, agentId);
      }, 150);
    };
  }, [detachTerminal, ensureTerminalConnected]);

  // Clear the resyncing flag once the new attach lands.
  useEffect(() => {
    if (resyncing && connState === "connected") {
      setResyncing(false);
    }
  }, [resyncing, connState]);

  return useMemo(
    () => ({
      connState,
      connectedAgentId,
      terminalMode,
      terminalPlaceholderMessage,
      inCopyMode: copyMode === "copy" || copyMode === "exiting",
      copyMode,
      statusMessage,
      terminalHostRef: setTerminalHostRef,
      ctrlPendingRef,
      focusTerminal,
      ensureTerminalConnected,
      detachTerminal,
      sendTerminalInput,
      exitCopyMode,
      setTerminalHostRef,
      resyncing,
      draggingFiles,
      uploadingFiles,
    }),
    [
      connState,
      copyMode,
      connectedAgentId,
      terminalMode,
      terminalPlaceholderMessage,
      statusMessage,
      focusTerminal,
      ensureTerminalConnected,
      detachTerminal,
      sendTerminalInput,
      exitCopyMode,
      setTerminalHostRef,
      resyncing,
      uploadingFiles,
      draggingFiles,
    ]
  );
}
