import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const shortcuts = [
  ["Enter", "Enter", "\r"],
  ["Esc", "Escape", "\x1b"],
  ["Tab", "Tab", "\t"],
  ["←", "Arrow Left", "\x1b[D"],
  ["↑", "Arrow Up", "\x1b[A"],
  ["↓", "Arrow Down", "\x1b[B"],
  ["→", "Arrow Right", "\x1b[C"],
] as const;

export function MobileTerminalControls({
  target,
  ctrlArmed,
  onToggleCtrl,
  sendInput,
}: {
  target: { id: string; user: string; host: string; cwd: string };
  ctrlArmed: boolean;
  onToggleCtrl: () => void;
  sendInput: (data: string, targetId: string, foldCtrl?: boolean) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const close = () => {
    setOpen(false);
    setDraft("");
  };
  const submit = (enter: boolean) => {
    if (draft && sendInput(draft + (enter ? "\r" : ""), target.id, false))
      close();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (value) setOpen(true);
        else close();
      }}
    >
      <div
        className="grid grid-cols-4 gap-1 border-t border-border pt-2 md:hidden"
        aria-label="Terminal shortcuts"
      >
        {shortcuts.map(([text, label, data]) => (
          <Button
            key={label}
            type="button"
            size="sm"
            aria-label={`Send ${label}`}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => sendInput(data, target.id)}
          >
            {text}
          </Button>
        ))}
        <Button
          type="button"
          size="sm"
          aria-label="Toggle Control modifier"
          aria-pressed={ctrlArmed}
          variant={ctrlArmed ? "primary" : "default"}
          className={ctrlArmed ? "ring-2 ring-primary" : undefined}
          onPointerDown={(event) => event.preventDefault()}
          onClick={onToggleCtrl}
        >
          Ctrl
        </Button>
        <DialogTrigger asChild>
          <Button type="button" size="sm" className="col-span-4">
            Paste / type
          </Button>
        </DialogTrigger>
      </div>

      <DialogContent
        className="h-dvh max-h-dvh w-full rounded-none md:h-auto md:max-h-[80vh] md:w-[min(560px,calc(100vw-2rem))] md:rounded-xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          textarea.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Terminal input</DialogTitle>
          <DialogDescription className="[overflow-wrap:anywhere]">
            {target.user}@{target.host} · {target.cwd} ·{" "}
            <span className="whitespace-nowrap">{target.id.slice(0, 8)}</span>
          </DialogDescription>
        </DialogHeader>
        <Textarea
          ref={textarea}
          aria-label="Terminal input text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="min-h-0 flex-1 resize-none font-mono text-base md:min-h-64"
          autoFocus
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={close}>
            Cancel
          </Button>
          <Button type="button" onClick={() => submit(true)}>
            Send + Enter
          </Button>
          <Button type="button" onClick={() => submit(false)}>
            Send Raw
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
