import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Pencil, Plus, X } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { type TemplateArg } from "@/hooks/use-templates";
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

  const handlePhraseClick = useCallback(
    (phrase: QuickPhrase) => {
      if (!canInject || injectMutation.isPending) return;
      if (phrase.args.length > 0) {
        setOpen(false);
        setFilling({ phrase, argValues: {} });
      } else {
        injectMutation.mutate({ phraseId: phrase.id });
      }
    },
    [canInject, injectMutation]
  );

  const handleInjectWithArgs = useCallback(() => {
    if (!filling) return;
    injectMutation.mutate({
      phraseId: filling.phrase.id,
      args: filling.argValues,
    });
  }, [filling, injectMutation]);

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
        <PopoverContent align="start" className="w-72 p-0">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Quick Phrases
            </h4>
            <button
              type="button"
              className="rounded p-1 text-muted-foreground hover:bg-white/[0.1] hover:text-foreground"
              onClick={() => setEditing({ id: "", label: "", text: "" })}
              title="Add phrase"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {phrases.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                No phrases yet
              </div>
            ) : (
              phrases.map((phrase) => (
                <div
                  key={phrase.id}
                  className="group flex items-center gap-1 border-b border-border/50 last:border-b-0"
                >
                  <button
                    type="button"
                    className={cn(
                      "flex-1 truncate px-3 py-2 text-left text-sm",
                      canInject
                        ? "hover:bg-white/[0.06]"
                        : "cursor-default opacity-50",
                      injectMutation.isPending &&
                        "pointer-events-none opacity-50"
                    )}
                    onClick={() => handlePhraseClick(phrase)}
                    title={
                      canInject
                        ? phrase.text
                        : "Connect to an agent session to inject"
                    }
                  >
                    <span className="text-foreground">
                      {phrase.label || phrase.text}
                    </span>
                    {phrase.label ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {phrase.text}
                      </span>
                    ) : null}
                  </button>
                  <div className="mr-1 hidden items-center gap-0.5 group-hover:flex group-focus-within:flex">
                    <button
                      type="button"
                      className="rounded p-1 text-muted-foreground hover:bg-white/[0.1] hover:text-foreground"
                      onClick={() =>
                        setEditing({
                          id: phrase.id,
                          label: phrase.label ?? "",
                          text: phrase.text,
                        })
                      }
                      title="Edit phrase"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      className="rounded p-1 text-muted-foreground hover:bg-white/[0.1] hover:text-foreground"
                      onClick={() => deleteMutation.mutate(phrase.id)}
                      title="Remove phrase"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                </div>
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
                <label
                  htmlFor="phrase-text"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Phrase text
                </label>
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
                <p className="text-xs text-muted-foreground">
                  Use{" "}
                  <code className="rounded bg-white/[0.06] px-1 py-0.5">
                    {"{{D:Variable Name}}"}
                  </code>{" "}
                  for fill-in variables.{" "}
                  <code className="rounded bg-white/[0.06] px-1 py-0.5">
                    |required
                  </code>{" "}
                  and{" "}
                  <code className="rounded bg-white/[0.06] px-1 py-0.5">
                    |multiline
                  </code>{" "}
                  modifiers are supported.
                </p>
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
                handleInjectWithArgs();
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
                <Button
                  type="submit"
                  disabled={fillingRequiredMissing || injectMutation.isPending}
                >
                  {injectMutation.isPending ? "Sending…" : "Inject"}
                </Button>
              </div>
            </form>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
