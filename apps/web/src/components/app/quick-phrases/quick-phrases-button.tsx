import { useCallback, useMemo, useState } from "react";
import { MessageSquare, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { parseTemplateArgs } from "@/hooks/use-templates";
import {
  useQuickPhrases,
  useQuickPhraseActions,
  type QuickPhrase,
} from "@/hooks/use-quick-phrases";

import { EditPhraseDialog, type EditingPhrase } from "./edit-phrase-dialog";
import {
  FillVariablesDialog,
  type FillingPhrase,
} from "./fill-variables-dialog";
import { PhraseRow } from "./phrase-row";

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
        <PopoverContent
          align="start"
          className="w-[28rem] max-w-[calc(100vw-2rem)] p-0"
        >
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
