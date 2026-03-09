import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type TerminalShortcut = {
  label: string;
  keyInput: string;
  ariaLabel: string;
};

const PRIMARY_SHORTCUTS: TerminalShortcut[] = [
  { label: "Esc", keyInput: "\u001b", ariaLabel: "Send Escape" },
  { label: "Tab", keyInput: "\t", ariaLabel: "Send Tab" },
  { label: "Enter", keyInput: "\r", ariaLabel: "Send Enter" }
];

const ARROW_SHORTCUTS: TerminalShortcut[] = [
  { label: "\u2191", keyInput: "\u001b[A", ariaLabel: "Send Arrow Up" },
  { label: "\u2193", keyInput: "\u001b[B", ariaLabel: "Send Arrow Down" },
  { label: "\u2190", keyInput: "\u001b[D", ariaLabel: "Send Arrow Left" },
  { label: "\u2192", keyInput: "\u001b[C", ariaLabel: "Send Arrow Right" }
];

type MobileTerminalToolbarProps = {
  onSendInput: (data: string) => void;
};

export function MobileTerminalToolbar({ onSendInput }: MobileTerminalToolbarProps): JSX.Element {
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const hasDraft = useMemo(() => draft.length > 0, [draft]);

  const sendDraft = (appendEnter: boolean) => {
    if (!hasDraft) {
      return;
    }
    onSendInput(appendEnter ? `${draft}\r` : draft);
    setDraft("");
    setComposerOpen(false);
  };

  const sendNextCharacter = () => {
    if (!hasDraft) {
      return;
    }

    const nextChar = draft[0];
    if (!nextChar) {
      return;
    }

    if (ctrlArmed) {
      const upper = nextChar.toUpperCase();
      const code = upper.charCodeAt(0);
      if (code >= 65 && code <= 90) {
        onSendInput(String.fromCharCode(code - 64));
      } else {
        onSendInput(nextChar);
      }
      setCtrlArmed(false);
    } else {
      onSendInput(nextChar);
    }

    setDraft("");
    setComposerOpen(false);
  };

  return (
    <>
      <div className="border-t-2 border-border bg-[#12130f] px-2 py-2 md:hidden">
        <div className="flex flex-col items-center gap-2">
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="primary"
              className="h-8 px-3 text-xs"
              onClick={() => setComposerOpen(true)}
            >
              Input
            </Button>
            <Button
              type="button"
              size="sm"
              variant={ctrlArmed ? "primary" : "default"}
              className="h-8 px-3 text-xs"
              aria-label="Toggle control modifier for next character"
              onClick={() => setCtrlArmed((current) => !current)}
            >
              Ctrl
            </Button>
            {PRIMARY_SHORTCUTS.map((shortcut) => (
              <Button
                key={shortcut.label}
                type="button"
                size="sm"
                variant="default"
                className="h-8 px-3 text-xs"
                aria-label={shortcut.ariaLabel}
                onClick={() => onSendInput(shortcut.keyInput)}
              >
                {shortcut.label}
              </Button>
            ))}
          </div>

          <div className="flex items-center justify-center gap-2">
            {ARROW_SHORTCUTS.map((shortcut) => (
              <Button
                key={shortcut.label}
                type="button"
                size="sm"
                variant="default"
                className="h-8 min-w-10 px-3 text-xs"
                aria-label={shortcut.ariaLabel}
                onClick={() => onSendInput(shortcut.keyInput)}
              >
                {shortcut.label}
              </Button>
            ))}
          </div>
        </div>
      </div>

      <Dialog open={composerOpen} onOpenChange={setComposerOpen}>
        <DialogContent className="left-0 top-0 box-border flex h-[100dvh] max-h-[100dvh] w-[100dvw] max-w-[100dvw] translate-x-0 translate-y-0 flex-col gap-3 overflow-hidden rounded-none border-0 p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:left-1/2 sm:top-1/2 sm:h-auto sm:w-[min(560px,calc(100vw-2rem))] sm:max-h-[calc(100dvh-2rem)] sm:max-w-[min(560px,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:border sm:p-4">
          <DialogHeader>
            <DialogTitle>Terminal Input</DialogTitle>
            <DialogDescription>Type or paste text, then send it to the active terminal session.</DialogDescription>
          </DialogHeader>

          <textarea
            className="min-h-0 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Paste commands or notes here..."
            autoFocus
          />

          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button type="button" variant="ghost" onClick={() => setComposerOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant="default" disabled={!hasDraft} onClick={sendNextCharacter}>
              {ctrlArmed ? "Send Ctrl+Key" : "Send Key"}
            </Button>
            <Button type="button" variant="default" disabled={!hasDraft} onClick={() => sendDraft(false)}>
              Send Raw
            </Button>
            <Button type="button" variant="primary" disabled={!hasDraft} onClick={() => sendDraft(true)}>
              Send + Enter
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
