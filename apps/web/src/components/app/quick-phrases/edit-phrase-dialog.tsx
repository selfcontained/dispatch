import { useRef, useState } from "react";
import { Info } from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
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
import { IconButton } from "@/components/ui/icon-button";
import { parseTemplateArgs } from "@/hooks/use-templates";
import { Alert } from "@/components/ui/alert";
import { Field } from "@/components/ui/field";

export type EditingPhrase = { id: string; label: string; text: string } | null;

export function EditPhraseDialog({
  editing,
  onClose,
  onSave,
  onChange,
  isSaving,
  error,
  detectedArgs,
}: {
  editing: EditingPhrase;
  onClose: () => void;
  onSave: () => void;
  onChange: (value: EditingPhrase) => void;
  isSaving: boolean;
  error: unknown;
  detectedArgs: ReturnType<typeof parseTemplateArgs>;
}) {
  const [variableHelpOpen, setVariableHelpOpen] = useState(false);
  const dialogContentRef = useRef<HTMLDivElement | null>(null);

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
        <DialogContent ref={dialogContentRef} size="sm" busy={isSaving}>
          <DialogHeader>
            <DialogTitle>
              {editing.id ? "Edit phrase" : "New phrase"}
            </DialogTitle>
            <DialogDescription>
              {editing.id
                ? "Update the label or text for this phrase."
                : "Add a new phrase to inject into agent sessions."}
            </DialogDescription>
          </DialogHeader>
          <DialogForm
            onSubmit={(e) => {
              e.preventDefault();
              onSave();
            }}
          >
            <DialogBody className="flex flex-col gap-3">
              <Field id="phrase-label" label="Label" optional>
                <Input
                  value={editing.label}
                  onChange={(e) =>
                    onChange({ ...editing, label: e.target.value })
                  }
                  placeholder="Short display name…"
                  maxLength={200}
                  autoFocus
                />
              </Field>
              <Field
                id="phrase-text"
                label="Phrase text"
                labelAction={
                  <Popover
                    open={variableHelpOpen}
                    onOpenChange={setVariableHelpOpen}
                  >
                    <PopoverTrigger asChild>
                      <IconButton
                        size="icon-xs"
                        label="Phrase variable help"
                        // The popover it opens on hover is its tooltip.
                        tooltip=""
                        onMouseEnter={() => setVariableHelpOpen(true)}
                      >
                        <Info />
                      </IconButton>
                    </PopoverTrigger>
                    <PopoverContent
                      container={dialogContentRef.current}
                      side="right"
                      className="z-tooltip w-64 px-2 py-1 text-body-sm"
                    >
                      <p>
                        Variables like{" "}
                        <code className="rounded-sm bg-fill-hover px-1 py-0.5 text-label-sm">
                          {"{{D:Name}}"}
                        </code>{" "}
                        become prompts before the phrase is sent. Add
                        |default=main for a prefill or |options=dev,production
                        for a dropdown; modifiers work in any order.
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
                }
              >
                <Textarea
                  value={editing.text}
                  onChange={(e) =>
                    onChange({ ...editing, text: e.target.value })
                  }
                  placeholder="Text to inject into the terminal…"
                  maxLength={1000}
                  rows={3}
                  className="resize-none"
                />
                {detectedArgs.length > 0 ? (
                  <div className="mt-0.5 flex items-start gap-1.5 text-body-sm text-muted-foreground">
                    <span className="shrink-0">Detected variables:</span>
                    <span className="flex flex-wrap gap-1">
                      {detectedArgs.map((a) => (
                        <span
                          key={a.key}
                          className="inline-block rounded-sm bg-surface-selected px-1.5 py-0.5 text-primary"
                        >
                          {a.name}
                          {a.required ? " *" : ""}
                          {a.multiline ? " (multiline)" : ""}
                          {a.error ? ` — ${a.error}` : ""}
                        </span>
                      ))}
                    </span>
                  </div>
                ) : null}
              </Field>
            </DialogBody>
            {error ? (
              <Alert
                title={
                  editing.id
                    ? "Couldn’t update the phrase."
                    : "Couldn’t save the phrase."
                }
                error={error}
              />
            ) : null}
            <DialogFooter>
              <DialogCancel />
              <Button
                type="submit"
                variant="primary"
                pending={isSaving}
                disabled={!editing.text.trim()}
              >
                {editing.id ? "Save phrase" : "Create phrase"}
              </Button>
            </DialogFooter>
          </DialogForm>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
