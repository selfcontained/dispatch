import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Info,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

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
import { parseTemplateArgs, type TemplateArg } from "@/hooks/use-templates";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type QuickPhrase = {
  id: string;
  label: string | null;
  text: string;
  args: TemplateArg[];
  sortOrder: number;
  createdAt: string;
};

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
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["quick-phrases"],
    queryFn: () => api<{ phrases: QuickPhrase[] }>("/api/v1/quick-phrases"),
    staleTime: 60_000,
  });

  const phrases = data?.phrases ?? [];

  const createMutation = useMutation({
    mutationFn: (input: { label?: string; text: string }) =>
      api<{ phrase: QuickPhrase }>("/api/v1/quick-phrases", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["quick-phrases"] });
      setEditing(null);
    },
    onError: () => toast.error("Failed to save phrase"),
  });

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      ...fields
    }: {
      id: string;
      label?: string | null;
      text?: string;
    }) =>
      api<{ phrase: QuickPhrase }>(`/api/v1/quick-phrases/${id}`, {
        method: "PATCH",
        body: JSON.stringify(fields),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["quick-phrases"] });
      setEditing(null);
    },
    onError: () => toast.error("Failed to update phrase"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      api<null>(`/api/v1/quick-phrases/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["quick-phrases"] });
    },
    onError: () => toast.error("Failed to delete phrase"),
  });

  const injectMutation = useMutation({
    mutationFn: (input: {
      phraseId: string;
      args?: Record<string, string>;
      submit?: boolean;
    }) => {
      if (!agentId) throw new Error("No active session");
      return api<null>(`/api/v1/agents/${agentId}/terminal/inject-phrase`, {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    onSuccess: () => {
      setOpen(false);
      setFilling(null);
      focusTerminal();
    },
    onError: () => toast.error("Failed to send phrase"),
  });

  const handleInject = useCallback(
    (phrase: QuickPhrase, submit: boolean) => {
      if (!canInject || injectMutation.isPending) return;
      injectMutation.mutate({ phraseId: phrase.id, submit });
    },
    [canInject, injectMutation]
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
      if (!filling) return;
      injectMutation.mutate({
        phraseId: filling.phrase.id,
        args: filling.argValues,
        submit,
      });
    },
    [filling, injectMutation]
  );

  const handleSave = useCallback(() => {
    if (!editing) return;
    const text = editing.text.trim();
    if (!text) return;
    const label = editing.label.trim() || undefined;

    if (editing.id) {
      updateMutation.mutate({ id: editing.id, label: label ?? null, text });
    } else {
      createMutation.mutate({ label, text });
    }
  }, [editing, createMutation, updateMutation]);

  const isSaving = createMutation.isPending || updateMutation.isPending;

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
                  isPending={injectMutation.isPending}
                  onInject={(submit) => handleInject(phrase, submit)}
                  onFill={() => handleFill(phrase)}
                  onEdit={() =>
                    setEditing({
                      id: phrase.id,
                      label: phrase.label ?? "",
                      text: phrase.text,
                    })
                  }
                  onDelete={() => deleteMutation.mutate(phrase.id)}
                />
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>

      {/* Add / Edit phrase dialog */}
      <Dialog
        open={editing !== null}
        onOpenChange={(v) => {
          if (!v) setEditing(null);
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
                handleSave();
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
                    setEditing({ ...editing, label: e.target.value })
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
                  onChange={(e) =>
                    setEditing({ ...editing, text: e.target.value })
                  }
                  placeholder="Text to inject into the terminal…"
                  maxLength={1000}
                  rows={3}
                  className="resize-none"
                />
                {editingDetectedArgs.length > 0 ? (
                  <div className="mt-0.5 flex items-start gap-1.5 text-xs text-muted-foreground">
                    <span className="shrink-0">Detected variables:</span>
                    <span className="flex flex-wrap gap-1">
                      {editingDetectedArgs.map((a) => (
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
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setEditing(null)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={!editing.text.trim() || isSaving}
                >
                  {isSaving ? "Saving…" : "Save"}
                </Button>
              </div>
            </form>
          </DialogContent>
        ) : null}
      </Dialog>

      {/* Fill variables dialog */}
      <Dialog
        open={filling !== null}
        onOpenChange={(v) => {
          if (!v) setFilling(null);
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
                handleInjectWithArgs(true);
              }}
            >
              {filling.phrase.args.map((arg) => (
                <ArgInput
                  key={arg.key}
                  arg={arg}
                  value={filling.argValues[arg.key] ?? ""}
                  onChange={(value) =>
                    setFilling({
                      ...filling,
                      argValues: { ...filling.argValues, [arg.key]: value },
                    })
                  }
                />
              ))}
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setFilling(null)}
                >
                  Cancel
                </Button>
                <InjectSplitButton
                  disabled={fillingRequiredMissing || injectMutation.isPending}
                  isPending={injectMutation.isPending}
                  onInject={(submit) => handleInjectWithArgs(submit)}
                />
              </div>
            </form>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
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
