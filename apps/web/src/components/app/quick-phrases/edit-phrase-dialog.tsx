import { useState } from "react";
import { Info } from "lucide-react";
import { Link } from "react-router-dom";

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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  const [variableHelpOpen, setVariableHelpOpen] = useState(false);

  return (
    <Dialog
      open={editing !== null}
      onOpenChange={(v) => {
        if (!v) {
          setVariableHelpOpen(false);
          onClose();
        }
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
                <Popover
                  open={variableHelpOpen}
                  onOpenChange={setVariableHelpOpen}
                >
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      aria-label="Phrase variable help"
                      className="text-muted-foreground/60 hover:text-muted-foreground"
                      onMouseEnter={() => setVariableHelpOpen(true)}
                    >
                      <Info className="h-3 w-3" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    side="right"
                    className="z-[90] w-64 px-2 py-1 text-xs"
                  >
                    <p>
                      Variables like{" "}
                      <code className="rounded bg-white/[0.08] px-1 py-0.5 text-[11px]">
                        {"{{D:Name}}"}
                      </code>{" "}
                      become prompts before the phrase is sent.
                    </p>
                    <Link
                      to="/settings/help/agents"
                      className="mt-1 block text-right text-primary underline-offset-2 hover:underline"
                      onClick={() => setVariableHelpOpen(false)}
                    >
                      More info
                    </Link>
                  </PopoverContent>
                </Popover>
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
