import { Keyboard } from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
    if (!draft || sendInput(draft + SUBMIT_SUFFIX, target.id, false)) close();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (value) setOpen(true);
        else close();
      }}
    >
      <div className="relative border-t-2 border-border bg-surface px-2 py-2 md:hidden">
        <div className="flex min-h-[4.5rem] items-stretch gap-2">
          <div className="min-w-0 flex-1">
            <DialogTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="default"
                className="h-full w-full rounded-bl-[28px] px-2 text-xs"
                aria-label="Open text input"
              >
                <Keyboard className="h-5 w-5" strokeWidth={2} />
              </Button>
            </DialogTrigger>
          </div>

          <div className="flex shrink-0 flex-col items-stretch justify-center gap-2">
            <div className="flex w-full justify-between">
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
            <Button
              type="button"
              size="sm"
              variant="default"
              className="h-full w-full rounded-br-[28px] px-2 text-xs"
              aria-label="Send Enter"
              onClick={() => sendKey("\r")}
            >
              Enter
            </Button>
          </div>
        </div>
      </div>

      <DialogContent
        className="fixed inset-0 left-0 top-0 h-dvh max-h-none w-full translate-x-0 translate-y-0 gap-0 rounded-none border-0 bg-background/95 p-0 shadow-none backdrop-blur-sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          textarea.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">Terminal input</DialogTitle>
        <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
          <Button
            type="button"
            variant="ghost"
            className="h-11 shrink-0 px-3 text-sm"
            onClick={close}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            className="h-11 px-4 text-sm font-medium"
            onClick={submit}
          >
            Submit
          </Button>
        </div>
        <DialogDescription
          className="truncate px-4 pt-3 text-xs"
          title={`${target.user}@${target.host}:${target.cwd}`}
        >
          Sending to{" "}
          <span className="text-foreground">
            {target.cwd.split("/").filter(Boolean).pop() ?? target.cwd}
          </span>{" "}
          on {target.host}
        </DialogDescription>
        <div className="min-h-0 flex-1 p-4">
          <Textarea
            ref={textarea}
            aria-label="Terminal input text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="h-full min-h-0 w-full resize-none rounded-lg border border-white/[0.12] bg-white/[0.04] backdrop-blur-md shadow-[inset_0_2px_6px_rgba(0,0,0,0.3)] p-3 font-mono text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary focus-visible:ring-1 focus-visible:ring-primary"
            placeholder="Type command here..."
            autoFocus
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
