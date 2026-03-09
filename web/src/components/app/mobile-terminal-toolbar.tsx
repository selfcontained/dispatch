import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type TerminalShortcut = {
  label: string;
  keyInput: string;
  ariaLabel: string;
};

const SHORTCUTS: TerminalShortcut[] = [
  { label: "Esc", keyInput: "\u001b", ariaLabel: "Send Escape" },
  { label: "Ctrl+C", keyInput: "\u0003", ariaLabel: "Send Control C" },
  { label: "Ctrl+D", keyInput: "\u0004", ariaLabel: "Send Control D" },
  { label: "Tab", keyInput: "\t", ariaLabel: "Send Tab" },
  { label: "\u2191", keyInput: "\u001b[A", ariaLabel: "Send Arrow Up" },
  { label: "\u2193", keyInput: "\u001b[B", ariaLabel: "Send Arrow Down" },
  { label: "\u2190", keyInput: "\u001b[D", ariaLabel: "Send Arrow Left" },
  { label: "\u2192", keyInput: "\u001b[C", ariaLabel: "Send Arrow Right" },
  { label: "Enter", keyInput: "\r", ariaLabel: "Send Enter" }
];

type MobileTerminalToolbarProps = {
  onSendInput: (data: string) => void;
};

export function MobileTerminalToolbar({ onSendInput }: MobileTerminalToolbarProps): JSX.Element {
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const hasDraft = useMemo(() => draft.length > 0, [draft]);

  const sendDraft = (appendEnter: boolean) => {
    if (!hasDraft) {
      return;
    }
    onSendInput(appendEnter ? `${draft}\r` : draft);
    setDraft("");
    setComposerOpen(false);
  };

  return (
    <>
      <div className="border-t-2 border-border bg-[#12130f] px-2 py-2 md:hidden">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="primary"
            className="h-8 px-3 text-xs"
            onClick={() => setComposerOpen(true)}
          >
            Input
          </Button>
          {SHORTCUTS.map((shortcut) => (
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
      </div>

      <Dialog open={composerOpen} onOpenChange={setComposerOpen}>
        <DialogContent className="top-0 flex h-[100dvh] w-[100vw] -translate-x-1/2 -translate-y-0 flex-col gap-3 rounded-none border-0 p-4 sm:top-1/2 sm:h-auto sm:w-[min(560px,calc(100vw-2rem))] sm:-translate-y-1/2 sm:rounded-xl sm:border">
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

          <div className="flex items-center justify-end gap-2 pb-[env(safe-area-inset-bottom)]">
            <Button type="button" variant="ghost" onClick={() => setComposerOpen(false)}>
              Cancel
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
