import { Keyboard } from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
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

const SUBMIT_SUFFIX = "\r";

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
  const sendKey = (data: string) => sendInput(data, target.id);
  const submit = () => {
    if (draft && sendInput(draft + SUBMIT_SUFFIX, target.id, false)) close();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (value) setOpen(true);
        else close();
      }}
    >
      <div className="border-t-2 border-border bg-surface px-2 py-2 md:hidden">
        <div className="flex min-h-[4.5rem] items-stretch gap-2">
          <div className="min-w-0 flex-1">
            <Button
              type="button"
              size="sm"
              variant="default"
              className="h-full w-full px-2 text-xs"
              aria-label="Send Enter"
              onClick={() => sendKey("\r")}
            >
              Enter
            </Button>
          </div>

          <div className="flex shrink-0 flex-col items-center justify-center gap-2">
            <div className="flex justify-center gap-2">
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
                className={cn(
                  "h-8 shrink-0 px-3 text-xs",
                  ctrlArmed && "ring-2 ring-primary bg-primary/20 text-primary"
                )}
                aria-label="Toggle Control modifier"
                aria-pressed={ctrlArmed}
                onPointerDown={(e) => {
                  e.preventDefault();
                }}
                onClick={onToggleCtrl}
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
            </div>

            <div className="flex justify-center gap-2">
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

          <div className="min-w-0 flex-1">
            <DialogTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="default"
                className="h-full w-full px-2 text-xs"
                aria-label="Open text input"
              >
                <Keyboard className="h-5 w-5" strokeWidth={2} />
              </Button>
            </DialogTrigger>
          </div>
        </div>
      </div>

      <DialogContent
        className="h-dvh max-h-dvh w-full rounded-none md:h-auto md:max-h-[80vh] md:w-[min(560px,calc(100vw-2rem))] md:rounded-xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          textarea.current?.focus();
        }}
      >
        <DialogHeader>
          <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2 border-b border-border pb-3">
            <Button
              type="button"
              className="h-11 min-w-[4.5rem]"
              onClick={close}
            >
              Cancel
            </Button>
            <DialogTitle className="text-center text-sm font-medium">
              Terminal input
            </DialogTitle>
            <Button
              type="button"
              variant="primary"
              className="h-11 min-w-[4.5rem]"
              onClick={submit}
            >
              Submit
            </Button>
          </div>
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
      </DialogContent>
    </Dialog>
  );
}
