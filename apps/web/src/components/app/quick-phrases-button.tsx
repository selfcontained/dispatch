import { useCallback, useMemo, useState } from "react";
import {
  ChevronDown,
  Info,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  Trash2,
} from "lucide-react";

import { ArgInput } from "@/components/app/arg-input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { parseTemplateArgs } from "@/hooks/use-templates";
import {
  useQuickPhrases,
  useQuickPhraseActions,
  type QuickPhrase,
} from "@/hooks/use-quick-phrases";
import { cn } from "@/lib/utils";

type EditingPhrase = { id: string; label: string; text: string } | null;

type FillingPhrase = {
  phrase: QuickPhrase;
  argValues: Record<string, string>;
} | null;

export function QuickPhrasesButton({
  agentId,
  focusTerminal,
}: {
  agentId: string | null;
  focusTerminal: () => void;
}) {
  const canInject = agentId !== null;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<EditingPhrase>(null);
  const [filling, setFilling] = useState<FillingPhrase>(null);

  const { data } = useQuickPhrases();
  const phrases = data?.phrases ?? [];

  const actions = useQuickPhraseActions({
    onSaved: () => setEditing(null),
    onInjected: () => {
      setOpen(false);
      setFilling(null);
      focusTerminal();
    },
  });

  const handleInject = useCallback(
    (phrase: QuickPhrase, submit: boolean) => {
      if (!agentId || actions.injectPhrase.isPending) return;
      actions.injectPhrase.mutate({ agentId, phraseId: phrase.id, submit });
    },
    [agentId, actions.injectPhrase]
  );

  const handleFill = useCallback(
    (phrase: QuickPhrase) => {
      if (!canInject) return;
      setOpen(false);
      setFilling({ phrase, argValues: {} });
    },
    [canInject]
  );

  const handleInjectWithArgs = useCallback(
    (submit: boolean) => {
      if (!filling || !agentId) return;
      actions.injectPhrase.mutate({
        agentId,
        phraseId: filling.phrase.id,
        args: filling.argValues,
        submit,
      });
    },
    [agentId, filling, actions.injectPhrase]
  );

  const handleSave = useCallback(() => {
    if (!editing) return;
    const text = editing.text.trim();
    if (!text) return;
    const label = editing.label.trim() || undefined;

    if (editing.id) {
      actions.updatePhrase.mutate({
        id: editing.id,
        label: label ?? null,
        text,
      });
    } else {
      actions.createPhrase.mutate({ label, text });
    }
  }, [editing, actions.createPhrase, actions.updatePhrase]);

  const editingDetectedArgs = useMemo(
    () => (editing?.text ? parseTemplateArgs(editing.text) : []),
    [editing?.text]
  );

  const fillingRequiredMissing =
    filling?.phrase.args.some(
      (a) => a.required && !filling.argValues[a.key]?.trim()
    ) ?? false;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="pointer-events-auto"
            title="Quick phrases"
            data-testid="quick-phrases-button"
          >
            <MessageSquare className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-0">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Quick Phrases
            </h4>
            <button
              type="button"
              className="rounded p-1.5 text-muted-foreground hover:bg-white/[0.1] hover:text-foreground"
              onClick={() => setEditing({ id: "", label: "", text: "" })}
              title="Add phrase"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
          {!canInject ? (
            <div className="border-b border-border/50 bg-yellow-500/5 px-3 py-1.5 text-xs text-yellow-400/90">
              Connect to an agent session to inject phrases
            </div>
          ) : null}
          <div className="max-h-64 overflow-y-auto">
            {phrases.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                No phrases yet
              </div>
            ) : (
              phrases.map((phrase) => (
                <PhraseRow
                  key={phrase.id}
                  phrase={phrase}
                  canInject={canInject}
                  isPending={actions.injectPhrase.isPending}
                  onInject={(submit) => handleInject(phrase, submit)}
                  onFill={() => handleFill(phrase)}
                  onEdit={() =>
                    setEditing({
                      id: phrase.id,
                      label: phrase.label ?? "",
                      text: phrase.text,
                    })
                  }
                  onDelete={() => actions.deletePhrase.mutate(phrase.id)}
                />
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>

      <EditPhraseDialog
        editing={editing}
        onClose={() => setEditing(null)}
        onSave={handleSave}
        onChange={setEditing}
        isSaving={actions.isSaving}
        detectedArgs={editingDetectedArgs}
      />

      <FillVariablesDialog
        filling={filling}
        onClose={() => setFilling(null)}
        onFillChange={setFilling}
        onInject={handleInjectWithArgs}
        isPending={actions.injectPhrase.isPending}
        requiredMissing={fillingRequiredMissing}
      />
    </>
  );
}

function EditPhraseDialog({
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

function FillVariablesDialog({
  filling,
  onClose,
  onFillChange,
  onInject,
  isPending,
  requiredMissing,
}: {
  filling: FillingPhrase;
  onClose: () => void;
  onFillChange: (value: FillingPhrase) => void;
  onInject: (submit: boolean) => void;
  isPending: boolean;
  requiredMissing: boolean;
}) {
  return (
    <Dialog
      open={filling !== null}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      {filling !== null ? (
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {filling.phrase.label || "Fill Variables"}
            </DialogTitle>
            <DialogDescription>
              Fill in the variables below, then inject the phrase.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              onInject(true);
            }}
          >
            {filling.phrase.args.map((arg) => (
              <ArgInput
                key={arg.key}
                arg={arg}
                value={filling.argValues[arg.key] ?? ""}
                onChange={(value) =>
                  onFillChange({
                    ...filling,
                    argValues: { ...filling.argValues, [arg.key]: value },
                  })
                }
              />
            ))}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <InjectSplitButton
                disabled={requiredMissing || isPending}
                isPending={isPending}
                onInject={onInject}
              />
            </div>
          </form>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function PhraseRow({
  phrase,
  canInject,
  isPending,
  onInject,
  onFill,
  onEdit,
  onDelete,
}: {
  phrase: QuickPhrase;
  canInject: boolean;
  isPending: boolean;
  onInject: (submit: boolean) => void;
  onFill: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const hasArgs = phrase.args.length > 0;

  return (
    <div className="flex items-center gap-1.5 border-b border-border/50 px-2 py-1.5 last:border-b-0">
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {phrase.label || phrase.text}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        {canInject ? (
          hasArgs ? (
            <Button
              type="button"
              size="sm"
              disabled={isPending}
              className="h-7 min-w-[5.5rem] px-2 text-xs"
              onClick={onFill}
            >
              Send…
            </Button>
          ) : (
            <InjectSplitButton
              disabled={isPending}
              isPending={isPending}
              onInject={onInject}
              size="sm"
              insidePopover
            />
          )
        ) : null}
        <button
          type="button"
          className="rounded p-1.5 text-muted-foreground hover:bg-white/[0.1] hover:text-foreground"
          onClick={onEdit}
          title="Edit phrase"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="rounded p-1.5 text-muted-foreground hover:bg-white/[0.1] hover:text-foreground"
          onClick={onDelete}
          title="Delete phrase"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function InjectSplitButton({
  disabled,
  isPending,
  onInject,
  size = "default",
  insidePopover = false,
}: {
  disabled: boolean;
  isPending: boolean;
  onInject: (submit: boolean) => void;
  size?: "sm" | "default";
  insidePopover?: boolean;
}) {
  const isSm = size === "sm";

  return (
    <div className={cn("flex items-stretch", isSm && "min-w-[5.5rem]")}>
      <Button
        type={isSm ? "button" : "submit"}
        size={isSm ? "sm" : "default"}
        disabled={disabled}
        className={cn("rounded-r-none", isSm && "h-7 gap-1 px-2 text-xs")}
        onClick={
          isSm
            ? (e: React.MouseEvent) => {
                e.preventDefault();
                onInject(true);
              }
            : undefined
        }
      >
        {isSm ? <Play className="h-2.5 w-2.5 fill-current" /> : null}
        {isPending ? "Sending…" : isSm ? "Send" : "Send & Submit"}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size={isSm ? "sm" : "default"}
            disabled={disabled}
            className={cn(
              "rounded-l-none border-l border-l-white/20 px-1.5",
              isSm && "h-7"
            )}
          >
            <ChevronDown className={cn(isSm ? "h-3 w-3" : "h-3.5 w-3.5")} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className={cn("min-w-[180px]", insidePopover && "z-[90]")}
        >
          <DropdownMenuItem
            className="text-foreground"
            onSelect={() => onInject(false)}
          >
            Paste without submitting
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
