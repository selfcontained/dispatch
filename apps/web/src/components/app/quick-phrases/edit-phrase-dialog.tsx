import { Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { parseTemplateArgs } from "@/hooks/use-templates";

export type EditingPhrase = { id: string; label: string; text: string } | null;

export function EditPhraseDialog({
  editing,
  onClose,
  onSave,
  onChange,
  isSaving,
  detectedArgs,
}: {
  editing: EditingPhrase;
  onClose: () => void;
  onSave: () => void;
  onChange: (value: EditingPhrase) => void;
  isSaving: boolean;
  detectedArgs: ReturnType<typeof parseTemplateArgs>;
}) {
  return (
    <Dialog
      open={editing !== null}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      {editing !== null ? (
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editing.id ? "Edit Phrase" : "Add Phrase"}
            </DialogTitle>
            <DialogDescription>
              {editing.id
                ? "Update the label or text for this phrase."
                : "Add a new phrase to inject into agent sessions."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              onSave();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="phrase-label"
                className="text-xs font-medium text-muted-foreground"
              >
                Label (optional)
              </label>
              <Input
                id="phrase-label"
                value={editing.label}
                onChange={(e) =>
                  onChange({ ...editing, label: e.target.value })
                }
                placeholder="Short display name…"
                maxLength={200}
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                <label
                  htmlFor="phrase-text"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Phrase text
                </label>
                <TooltipProvider delayDuration={120}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="text-muted-foreground/60 hover:text-muted-foreground"
                      >
                        <Info className="h-3 w-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-64">
                      <p>
                        Use{" "}
                        <code className="rounded bg-white/[0.08] px-1 py-0.5 text-[11px]">
                          {"{{D:Name}}"}
                        </code>{" "}
                        for fill-in variables. Add{" "}
                        <code className="rounded bg-white/[0.08] px-1 py-0.5 text-[11px]">
                          |required
                        </code>{" "}
                        or{" "}
                        <code className="rounded bg-white/[0.08] px-1 py-0.5 text-[11px]">
                          |multiline
                        </code>{" "}
                        modifiers after the name.
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <Textarea
                id="phrase-text"
                value={editing.text}
                onChange={(e) => onChange({ ...editing, text: e.target.value })}
                placeholder="Text to inject into the terminal…"
                maxLength={1000}
                rows={3}
                className="resize-none"
              />
              {detectedArgs.length > 0 ? (
                <div className="mt-0.5 flex items-start gap-1.5 text-xs text-muted-foreground">
                  <span className="shrink-0">Detected variables:</span>
                  <span className="flex flex-wrap gap-1">
                    {detectedArgs.map((a) => (
                      <span
                        key={a.key}
                        className="inline-block rounded bg-primary/10 px-1.5 py-0.5 text-primary"
                      >
                        {a.name}
                        {a.required ? " *" : ""}
                        {a.multiline ? " (multiline)" : ""}
                      </span>
                    ))}
                  </span>
                </div>
              ) : null}
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!editing.text.trim() || isSaving}>
                {isSaving ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
