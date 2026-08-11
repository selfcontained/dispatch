import { Keyboard } from "lucide-react";
import { useAtomValue } from "jotai";
import { useMutation } from "@tanstack/react-query";
import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { TerminalCopyModeBannerLayer } from "@/components/app/terminal-copy-mode-banner";
import { type TerminalCopyMode } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { soundCuesEnabledAtom } from "@/lib/store";
import { playTapCue } from "@/lib/sound-cues";
import { cn } from "@/lib/utils";

type MobileTerminalToolbarProps = {
  agentId: string | null;
  onSendInput: (data: string) => void;
  onExitCopyMode: () => void;
  ctrlPendingRef: MutableRefObject<boolean>;
  isConnected: boolean;
  copyMode: TerminalCopyMode | "unknown";
};

export function MobileTerminalToolbar({
  agentId,
  onSendInput,
  onExitCopyMode,
  ctrlPendingRef,
  isConnected,
  copyMode,
}: MobileTerminalToolbarProps): JSX.Element {
  const [inputOpen, setInputOpen] = useState(false);
  const [ctrlActive, setCtrlActive] = useState(false);
  const [flashState, setFlashState] = useState<{
    key: string;
    token: number;
  } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const soundCuesEnabled = useAtomValue(soundCuesEnabledAtom);

  const playTap = useCallback(() => {
    if (soundCuesEnabled) playTapCue();
  }, [soundCuesEnabled]);

  // Clear visual state when the terminal onData handler consumes the ctrl modifier
  useEffect(() => {
    const onConsumed = () => setCtrlActive(false);
    window.addEventListener("ctrl-consumed", onConsumed);
    return () => window.removeEventListener("ctrl-consumed", onConsumed);
  }, []);

  useEffect(() => {
    if (!flashState) return;
    const timeout = window.setTimeout(() => setFlashState(null), 420);
    return () => window.clearTimeout(timeout);
  }, [flashState]);

  const triggerFlash = useCallback((key: string) => {
    setFlashState(null);
    requestAnimationFrame(() => {
      setFlashState({ key, token: Date.now() });
    });
  }, []);

  const flashButtonClass = useCallback(
    (key: string) =>
      flashState?.key === key ? "animate-mobile-toolbar-flash" : "",
    [flashState]
  );

  const flashDataState = useCallback(
    (key: string) =>
      flashState?.key === key ? `flash-${flashState.token}` : "",
    [flashState]
  );

  const toggleCtrl = useCallback(() => {
    playTap();
    setCtrlActive((v) => {
      const next = !v;
      ctrlPendingRef.current = next;
      return next;
    });
  }, [ctrlPendingRef, playTap]);

  const sendKey = useCallback(
    (key: string, flashKey?: string) => {
      if (!isConnected) return;
      if (flashKey) triggerFlash(flashKey);
      playTap();
      onSendInput(key);
      // After any toolbar key press, clear ctrl
      if (ctrlActive) {
        setCtrlActive(false);
        ctrlPendingRef.current = false;
      }
    },
    [
      ctrlActive,
      ctrlPendingRef,
      isConnected,
      onSendInput,
      playTap,
      triggerFlash,
    ]
  );

  const openInput = useCallback(() => {
    if (!isConnected) return;
    triggerFlash("input");
    playTap();
    setInputOpen(true);
    // Double-rAF ensures the modal is rendered and laid out before focusing,
    // which avoids iOS failing to open the keyboard on the first tap.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => inputRef.current?.focus());
    });
  }, [isConnected, playTap, triggerFlash]);

  // Injection goes through the server API (tmux paste-buffer) rather than
  // writing straight to the pty over the terminal WS — that's what makes
  // multi-line/pasted text land reliably instead of racing raw keystrokes.
  const injectText = useMutation({
    mutationFn: (input: { text: string; submit: boolean }) =>
      api<null>(`/api/v1/agents/${agentId}/terminal/inject-text`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onError: () => toast.error("Failed to send input"),
  });

  const sendFullscreenInput = useCallback(
    (submit: boolean) => {
      if (!isConnected || !agentId) return;
      playTap();
      const text = inputRef.current?.value;
      if (text) {
        injectText.mutate({ text, submit });
        if (inputRef.current) inputRef.current.value = "";
      }
      setInputOpen(false);
    },
    [agentId, injectText, isConnected, playTap]
  );

  const submitInput = useCallback(
    () => sendFullscreenInput(true),
    [sendFullscreenInput]
  );
  const pasteInput = useCallback(
    () => sendFullscreenInput(false),
    [sendFullscreenInput]
  );

  const pausedInput = copyMode === "copy" || copyMode === "exiting";

  return (
    <>
      <div className="relative border-t-2 border-border bg-surface px-2 py-2 md:hidden">
        <div className="flex min-h-[4.5rem] items-stretch gap-2">
          <div className="min-w-0 flex-1">
            <Button
              type="button"
              size="sm"
              variant="default"
              className={cn(
                "h-full w-full rounded-bl-[28px] px-2 text-xs",
                flashButtonClass("input")
              )}
              aria-label="Open text input"
              onClick={openInput}
              disabled={!isConnected}
              data-flash-state={flashDataState("input")}
            >
              <Keyboard className="h-5 w-5" strokeWidth={2} />
            </Button>
          </div>

          <div className="flex shrink-0 flex-col items-stretch justify-center gap-2">
            <div className="flex w-full justify-between">
              <Button
                type="button"
                size="sm"
                variant="default"
                className={cn(
                  "h-8 shrink-0 px-3 text-xs",
                  flashButtonClass("esc")
                )}
                aria-label="Send Escape"
                onClick={() => sendKey("\u001b", "esc")}
                disabled={!isConnected}
                data-flash-state={flashDataState("esc")}
              >
                Esc
              </Button>
              <Button
                type="button"
                size="sm"
                variant="default"
                className={cn(
                  "h-8 shrink-0 px-3 text-xs",
                  ctrlActive && "ring-2 ring-primary bg-primary/20 text-primary"
                )}
                aria-label="Toggle Control modifier"
                aria-pressed={ctrlActive}
                onPointerDown={(e) => {
                  e.preventDefault();
                  toggleCtrl();
                }}
                disabled={!isConnected}
              >
                Ctrl
              </Button>
              <Button
                type="button"
                size="sm"
                variant="default"
                className={cn(
                  "h-8 shrink-0 px-3 text-xs",
                  flashButtonClass("tab")
                )}
                aria-label="Send Tab"
                onClick={() => sendKey("\t", "tab")}
                disabled={!isConnected}
                data-flash-state={flashDataState("tab")}
              >
                Tab
              </Button>
            </div>

            <div className="flex justify-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="default"
                className={cn(
                  "h-8 w-10 shrink-0 px-0 text-base",
                  flashButtonClass("left")
                )}
                aria-label="Send Arrow Left"
                onClick={() => sendKey("\u001b[D", "left")}
                disabled={!isConnected}
                data-flash-state={flashDataState("left")}
              >
                ←
              </Button>
              <Button
                type="button"
                size="sm"
                variant="default"
                className={cn(
                  "h-8 w-10 shrink-0 px-0 text-base",
                  flashButtonClass("up")
                )}
                aria-label="Send Arrow Up"
                onClick={() => sendKey("\u001b[A", "up")}
                disabled={!isConnected}
                data-flash-state={flashDataState("up")}
              >
                ↑
              </Button>
              <Button
                type="button"
                size="sm"
                variant="default"
                className={cn(
                  "h-8 w-10 shrink-0 px-0 text-base",
                  flashButtonClass("down")
                )}
                aria-label="Send Arrow Down"
                onClick={() => sendKey("\u001b[B", "down")}
                disabled={!isConnected}
                data-flash-state={flashDataState("down")}
              >
                ↓
              </Button>
              <Button
                type="button"
                size="sm"
                variant="default"
                className={cn(
                  "h-8 w-10 shrink-0 px-0 text-base",
                  flashButtonClass("right")
                )}
                aria-label="Send Arrow Right"
                onClick={() => sendKey("\u001b[C", "right")}
                disabled={!isConnected}
                data-flash-state={flashDataState("right")}
              >
                →
              </Button>
            </div>
          </div>

          <div className="min-w-0 flex-1">
            <Button
              type="button"
              size="sm"
              variant="default"
              className={cn(
                "h-full w-full rounded-br-[28px] px-2 text-xs",
                flashButtonClass("enter")
              )}
              aria-label="Send Enter"
              onClick={() => sendKey("\r", "enter")}
              disabled={!isConnected}
              data-flash-state={flashDataState("enter")}
            >
              Enter
            </Button>
          </div>
        </div>

        {/* Float the banner above the keyboard shortcut bar's top edge —
            clears it visually with empty space, instead of sitting flush
            against the bar's border. */}
        <div className="pointer-events-none absolute inset-x-2 bottom-[6.5rem]">
          <TerminalCopyModeBannerLayer
            visible={pausedInput}
            copyMode={copyMode}
            onExitCopyMode={onExitCopyMode}
            disabled={!isConnected}
          />
        </div>
      </div>

      {/* Full-screen text input modal */}
      {inputOpen ? (
        <div className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <button
              className="text-sm text-muted-foreground"
              onClick={() => {
                playTap();
                setInputOpen(false);
              }}
            >
              Cancel
            </button>
            <span className="text-sm font-medium text-foreground">
              Terminal Input
            </span>
            {/* Invisible twin of the Cancel label so the title stays centered
                now that there's no header action on this side. */}
            <span
              className="invisible text-sm text-muted-foreground"
              aria-hidden="true"
            >
              Cancel
            </span>
          </div>
          <div className="flex-1 p-4">
            <textarea
              ref={inputRef}
              className="h-full w-full resize-none rounded-lg border border-white/[0.12] bg-white/[0.04] backdrop-blur-md shadow-[inset_0_2px_6px_rgba(0,0,0,0.3)] p-3 font-mono text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="Type command here..."
              autoCapitalize="off"
            />
          </div>
          {/* Bigger tap targets matching the keyboard control bar below, with
              an exaggerated outside-bottom-corner radius so the row is easy
              to hit and doesn't clip on curved-screen devices. */}
          <div
            className="flex gap-3 border-t border-border px-3 pt-3"
            style={{
              paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))",
            }}
          >
            <Button
              type="button"
              variant="default"
              className="h-16 flex-1 rounded-t-lg rounded-bl-[28px] rounded-br-lg text-base font-medium"
              aria-label="Paste without submitting"
              onClick={pasteInput}
              disabled={!isConnected || injectText.isPending}
            >
              Paste
            </Button>
            <Button
              type="button"
              variant="primary"
              className="h-16 flex-1 rounded-t-lg rounded-br-[28px] rounded-bl-lg text-base font-medium"
              aria-label="Submit with Enter"
              onClick={submitInput}
              disabled={!isConnected || injectText.isPending}
            >
              Submit
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
