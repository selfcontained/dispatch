import { Keyboard } from "lucide-react";
import { useAtomValue } from "jotai";
import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { soundCuesEnabledAtom } from "@/lib/store";
import { playTapCue } from "@/lib/sound-cues";
import { cn } from "@/lib/utils";

type MobileTerminalToolbarProps = {
  onSendInput: (data: string) => void;
  ctrlPendingRef: MutableRefObject<boolean>;
  isConnected: boolean;
};

export function MobileTerminalToolbar({
  onSendInput,
  ctrlPendingRef,
  isConnected,
}: MobileTerminalToolbarProps): JSX.Element {
  const [inputOpen, setInputOpen] = useState(false);
  const [ctrlActive, setCtrlActive] = useState(false);
  const [flashState, setFlashState] = useState<{
    key: string;
    token: number;
  } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const soundCuesEnabled = useAtomValue(soundCuesEnabledAtom);

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = `
      @keyframes mobile-toolbar-flash {
        0% { opacity: 0; }
        18% { opacity: 1; }
        100% { opacity: 0; }
      }
    `;
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, []);

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
    const timeout = window.setTimeout(() => setFlashState(null), 450);
    return () => window.clearTimeout(timeout);
  }, [flashState]);

  const triggerFlash = useCallback((key: string) => {
    setFlashState({ key, token: Date.now() });
  }, []);

  const renderFlash = useCallback(
    (key: string) =>
      flashState?.key === key ? (
        <span
          key={`${key}-${flashState.token}`}
          data-testid={`toolbar-flash-${key}`}
          className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 [animation-fill-mode:forwards] animate-[mobile-toolbar-flash_420ms_ease-out] bg-[linear-gradient(180deg,rgba(190,240,255,0.22),rgba(190,240,255,0.06))] shadow-[inset_0_0_0_1px_rgba(190,240,255,0.22),0_0_30px_rgba(100,190,255,0.12)]"
        />
      ) : null,
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

  const submitInput = useCallback(() => {
    if (!isConnected) return;
    playTap();
    const text = inputRef.current?.value;
    if (text) {
      onSendInput(text + "\r");
      if (inputRef.current) inputRef.current.value = "";
    }
    setInputOpen(false);
  }, [isConnected, onSendInput, playTap]);

  return (
    <>
      <div className="border-t-2 border-border bg-surface px-2 py-2 md:hidden">
        <div className="flex min-h-[4.5rem] items-stretch gap-2">
          <div className="min-w-0 flex-1">
            <Button
              type="button"
              size="sm"
              variant="default"
              className="relative h-full w-full overflow-hidden rounded-bl-[28px] px-2 text-xs"
              aria-label="Open text input"
              onClick={openInput}
              disabled={!isConnected}
            >
              {renderFlash("input")}
              <Keyboard className="h-5 w-5" strokeWidth={2} />
            </Button>
          </div>

          <div className="flex shrink-0 flex-col items-stretch justify-center gap-2">
            <div className="flex w-full justify-between">
              <Button
                type="button"
                size="sm"
                variant="default"
                className="relative h-8 shrink-0 overflow-hidden px-3 text-xs"
                aria-label="Send Escape"
                onClick={() => sendKey("\u001b", "esc")}
                disabled={!isConnected}
              >
                {renderFlash("esc")}
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
                className="relative h-8 shrink-0 overflow-hidden px-3 text-xs"
                aria-label="Send Tab"
                onClick={() => sendKey("\t", "tab")}
                disabled={!isConnected}
              >
                {renderFlash("tab")}
                Tab
              </Button>
            </div>

            <div className="flex justify-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="default"
                className="relative h-8 w-10 shrink-0 overflow-hidden px-0 text-base"
                aria-label="Send Arrow Left"
                onClick={() => sendKey("\u001b[D", "left")}
                disabled={!isConnected}
              >
                {renderFlash("left")}←
              </Button>
              <Button
                type="button"
                size="sm"
                variant="default"
                className="relative h-8 w-10 shrink-0 overflow-hidden px-0 text-base"
                aria-label="Send Arrow Up"
                onClick={() => sendKey("\u001b[A", "up")}
                disabled={!isConnected}
              >
                {renderFlash("up")}↑
              </Button>
              <Button
                type="button"
                size="sm"
                variant="default"
                className="relative h-8 w-10 shrink-0 overflow-hidden px-0 text-base"
                aria-label="Send Arrow Down"
                onClick={() => sendKey("\u001b[B", "down")}
                disabled={!isConnected}
              >
                {renderFlash("down")}↓
              </Button>
              <Button
                type="button"
                size="sm"
                variant="default"
                className="relative h-8 w-10 shrink-0 overflow-hidden px-0 text-base"
                aria-label="Send Arrow Right"
                onClick={() => sendKey("\u001b[C", "right")}
                disabled={!isConnected}
              >
                {renderFlash("right")}→
              </Button>
            </div>
          </div>

          <div className="min-w-0 flex-1">
            <Button
              type="button"
              size="sm"
              variant="default"
              className="relative h-full w-full overflow-hidden rounded-br-[28px] px-2 text-xs"
              aria-label="Send Enter"
              onClick={() => sendKey("\r", "enter")}
              disabled={!isConnected}
            >
              {renderFlash("enter")}
              Enter
            </Button>
          </div>
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
            <button
              className="text-sm font-medium text-primary"
              onClick={submitInput}
            >
              Send
            </button>
          </div>
          <div className="flex-1 p-4">
            <textarea
              ref={inputRef}
              className="h-full w-full resize-none rounded-lg border border-white/[0.12] bg-white/[0.04] backdrop-blur-md shadow-[inset_0_2px_6px_rgba(0,0,0,0.3)] p-3 font-mono text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="Type command here..."
              autoCapitalize="off"
            />
          </div>
          <div className="flex gap-3 border-t border-border px-4 py-3">
            <Button
              type="button"
              variant="default"
              className="flex-1"
              onClick={submitInput}
            >
              Send + Enter
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="flex-1"
              onClick={() => {
                playTap();
                const text = inputRef.current?.value;
                if (text) {
                  onSendInput(text);
                  if (inputRef.current) inputRef.current.value = "";
                }
                setInputOpen(false);
              }}
            >
              Send Raw
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
