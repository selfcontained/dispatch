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
          <div className="grid min-w-0 flex-1">
            <DialogTrigger asChild>
              <Button
                type="button"
                size="sm"
                className="w-full rounded-bl-screen text-body-sm"
                aria-label="Open text input"
              >
                <Keyboard strokeWidth={2} />
              </Button>
            </DialogTrigger>
          </div>

          <div className="flex shrink-0 flex-col items-stretch justify-center gap-2">
            <div className="flex w-full justify-between">
              <Button
                type="button"
                size="sm"
                className="shrink-0 text-body-sm"
                aria-label="Send Escape"
                onClick={() => sendKey("\u001b")}
              >
                Esc
              </Button>
              <Button
                type="button"
                size="sm"
                className={cn(
                  "shrink-0 text-body-sm",
                  ctrlArmed &&
                    "ring-2 ring-primary bg-primary/tint-strong text-primary"
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
                className="shrink-0 text-body-sm"
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
                className="w-10 shrink-0 text-body-lg"
                aria-label="Send Arrow Left"
                onClick={() => sendKey("\u001b[D")}
              >
                ←
              </Button>
              <Button
                type="button"
                size="sm"
                className="w-10 shrink-0 text-body-lg"
                aria-label="Send Arrow Up"
                onClick={() => sendKey("\u001b[A")}
              >
                ↑
              </Button>
              <Button
                type="button"
                size="sm"
                className="w-10 shrink-0 text-body-lg"
                aria-label="Send Arrow Down"
                onClick={() => sendKey("\u001b[B")}
              >
                ↓
              </Button>
              <Button
                type="button"
                size="sm"
                className="w-10 shrink-0 text-body-lg"
                aria-label="Send Arrow Right"
                onClick={() => sendKey("\u001b[C")}
              >
                →
              </Button>
            </div>
          </div>

          <div className="grid min-w-0 flex-1">
            <Button
              type="button"
              size="sm"
              className="w-full rounded-br-screen text-body-sm"
              aria-label="Send Enter"
              onClick={() => sendKey("\r")}
            >
              Enter
            </Button>
          </div>
        </div>
      </div>

      <DialogContent
        bare
        className="fixed inset-0 left-0 top-0 h-dvh max-h-none w-full translate-x-0 translate-y-0 gap-0 rounded-none border-0 bg-background/dense p-0 shadow-none backdrop-blur-sm"
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
            className="shrink-0"
            onClick={close}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            className="font-medium"
            onClick={submit}
          >
            Submit
          </Button>
        </div>
        <DialogDescription
          className="truncate px-4 pt-3 text-body-sm"
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
            className="h-full min-h-0 w-full resize-none rounded-lg surface-inset p-3 font-mono text-body-lg text-foreground placeholder:text-muted-foreground focus-ring"
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
