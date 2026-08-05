import { useCallback, useMemo, useRef, useState } from "react";
import { MessageSquare, Plus, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
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
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<EditingPhrase>(null);
  const [filling, setFilling] = useState<FillingPhrase>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const { data } = useQuickPhrases();
  const phrases = useMemo(() => data?.phrases ?? [], [data?.phrases]);
  const filteredPhrases = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return phrases;

    return phrases.filter((phrase) =>
      `${phrase.label ?? ""} ${phrase.text}`.toLowerCase().includes(query)
    );
  }, [phrases, search]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) setSearch("");
  }, []);

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

  const handleSelect = useCallback(
    (phrase: QuickPhrase) => {
      if (phrase.args.length > 0) {
        handleFill(phrase);
      } else {
        handleInject(phrase, true);
      }
    },
    [handleFill, handleInject]
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
      <Popover open={open} onOpenChange={handleOpenChange}>
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
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            searchInputRef.current?.focus();
          }}
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
          <Command shouldFilter={false} loop className="bg-transparent">
            <div className="relative">
              <Search className="pointer-events-none absolute left-4 top-1/2 z-10 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <CommandInput
                ref={searchInputRef}
                value={search}
                onValueChange={setSearch}
                placeholder="Search phrases..."
                aria-label="Search quick phrases"
                className="h-10 pl-7 text-sm"
              />
            </div>
            <CommandList className="max-h-64">
              {phrases.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  No phrases yet
                </div>
              ) : (
                <>
                  <CommandEmpty>No matching phrases</CommandEmpty>
                  <CommandGroup className="p-0">
                    {filteredPhrases.map((phrase) => (
                      <CommandItem
                        key={phrase.id}
                        value={phrase.id}
                        onSelect={() => handleSelect(phrase)}
                        className="border-b border-border/50 p-0 last:border-b-0 data-[selected=true]:bg-primary/10"
                      >
                        <PhraseRow
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
                          onDelete={() =>
                            actions.deletePhrase.mutate(phrase.id)
                          }
                        />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
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
