import { type MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type MobileTerminalToolbarProps = {
  onSendInput: (data: string) => void;
  ctrlPendingRef: MutableRefObject<boolean>;
};

export function MobileTerminalToolbar({ onSendInput, ctrlPendingRef }: MobileTerminalToolbarProps): JSX.Element {
  const [inputOpen, setInputOpen] = useState(false);
  const [ctrlActive, setCtrlActive] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Clear visual state when the terminal onData handler consumes the ctrl modifier
  useEffect(() => {
    const onConsumed = () => setCtrlActive(false);
    window.addEventListener("ctrl-consumed", onConsumed);
    return () => window.removeEventListener("ctrl-consumed", onConsumed);
  }, []);

  const toggleCtrl = useCallback(() => {
    setCtrlActive((v) => {
      const next = !v;
      ctrlPendingRef.current = next;
      return next;
    });
  }, [ctrlPendingRef]);

  const sendKey = useCallback((key: string) => {
    onSendInput(key);
    // After any toolbar key press, clear ctrl
    if (ctrlActive) {
      setCtrlActive(false);
      ctrlPendingRef.current = false;
    }
  }, [ctrlActive, ctrlPendingRef, onSendInput]);

  const openInput = useCallback(() => {
    setInputOpen(true);
    // Double-rAF ensures the modal is rendered and laid out before focusing,
    // which avoids iOS failing to open the keyboard on the first tap.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => inputRef.current?.focus());
    });
  }, []);

  const submitInput = useCallback(() => {
    const text = inputRef.current?.value;
    if (text) {
      onSendInput(text + "\r");
      if (inputRef.current) inputRef.current.value = "";
    }
    setInputOpen(false);
  }, [onSendInput]);

  return (
    <>
      <div className="border-t-2 border-border bg-surface px-2 py-2 md:hidden">
        {/* Row 1: modifier + action keys + keyboard button */}
        <div className="flex justify-center gap-2">
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
          >
            Ctrl
          </Button>
          <Button
            type="button"
            size="sm"
            variant="default"
            className="h-8 shrink-0 px-3 text-xs"
            aria-label="Send Tab"
            onClick={() => sendKey("\t")}
          >
            Tab
          </Button>
          <Button
            type="button"
            size="sm"
            variant="default"
            className="h-8 shrink-0 px-3 text-xs"
            aria-label="Send Escape"
            onClick={() => sendKey("\u001b")}
          >
            Esc
          </Button>
          <Button
            type="button"
            size="sm"
            variant="default"
            className="h-8 shrink-0 px-3 text-xs"
            aria-label="Send Enter"
            onClick={() => sendKey("\r")}
          >
            Enter
          </Button>
          <Button
            type="button"
            size="sm"
            variant="default"
            className="h-8 shrink-0 px-3 text-xs"
            aria-label="Open text input"
            onClick={openInput}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M6 16h8" />
            </svg>
          </Button>
        </div>

        {/* Row 2: arrow keys */}
        <div className="mt-2 flex justify-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="default"
            className="h-8 w-10 shrink-0 px-0 text-base"
            aria-label="Send Arrow Left"
            onClick={() => sendKey("\u001b[D")}
          >
            ←
          </Button>
          <Button
            type="button"
            size="sm"
            variant="default"
            className="h-8 w-10 shrink-0 px-0 text-base"
            aria-label="Send Arrow Up"
            onClick={() => sendKey("\u001b[A")}
          >
            ↑
          </Button>
          <Button
            type="button"
            size="sm"
            variant="default"
            className="h-8 w-10 shrink-0 px-0 text-base"
            aria-label="Send Arrow Down"
            onClick={() => sendKey("\u001b[B")}
          >
            ↓
          </Button>
          <Button
            type="button"
            size="sm"
            variant="default"
            className="h-8 w-10 shrink-0 px-0 text-base"
            aria-label="Send Arrow Right"
            onClick={() => sendKey("\u001b[C")}
          >
            →
          </Button>
        </div>
      </div>

      {/* Full-screen text input modal */}
      {inputOpen ? (
        <div className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <button
              className="text-sm text-muted-foreground"
              onClick={() => setInputOpen(false)}
            >
              Cancel
            </button>
            <span className="text-sm font-medium text-foreground">Terminal Input</span>
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
              className="h-full w-full resize-none rounded-lg border border-border bg-card p-3 font-mono text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
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
