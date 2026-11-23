import { useCallback, useMemo, useRef, useState } from "react";
import { MessageSquare, Plus, Search } from "lucide-react";

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
import { IconButton } from "@/components/ui/icon-button";
import { parseTemplateArgs, templateArgDefaults } from "@/hooks/use-templates";
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
import { Alert } from "@/components/ui/alert";
import { AsyncBoundary } from "@/components/ui/async-boundary";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "@/components/ui/toast";

export function QuickPhrasesButton({
  agentId,
  onInjected,
}: {
  agentId: string | null;
  /** Called after a phrase is delivered, e.g. to return focus somewhere. */
  onInjected?: () => void;
}) {
  const canInject = agentId !== null;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<EditingPhrase>(null);
  const [filling, setFilling] = useState<FillingPhrase>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const phrasesQuery = useQuickPhrases();
  const { data } = phrasesQuery;
  const [deleting, setDeleting] = useState<QuickPhrase | null>(null);
  const phrases = useMemo(() => data?.phrases ?? [], [data?.phrases]);
  const filteredPhrases = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return phrases;

    return phrases.filter((phrase) =>
      `${phrase.label ?? ""} ${phrase.text}`.toLowerCase().includes(query)
    );
  }, [phrases, search]);

  const actions = useQuickPhraseActions({
    onSaved: () => setEditing(null),
    onInjected: () => {
      setOpen(false);
      setFilling(null);
      onInjected?.();
    },
  });

  const { reset: resetInject } = actions.injectPhrase;
  const { reset: resetCreate } = actions.createPhrase;
  const { reset: resetUpdate } = actions.updatePhrase;
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (nextOpen) {
        setSearch("");
        resetInject();
      } else {
        setDeleting(null);
      }
    },
    [resetInject]
  );
  const startEditing = useCallback(
    (value: EditingPhrase) => {
      resetCreate();
      resetUpdate();
      setEditing(value);
    },
    [resetCreate, resetUpdate]
  );

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
      resetInject();
      setFilling({ phrase, argValues: templateArgDefaults(phrase.args) });
    },
    [canInject, resetInject]
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
      (a) =>
        Boolean(a.error) || (a.required && !filling.argValues[a.key]?.trim())
    ) ?? false;

  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <IconButton
            className="pointer-events-auto"
            label="Quick phrases"
            data-testid="quick-phrases-button"
          >
            <MessageSquare />
          </IconButton>
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
            <h4 className="section-label">Quick Phrases</h4>
            <IconButton
              size="icon-sm"
              label="New phrase"
              onClick={() => startEditing({ id: "", label: "", text: "" })}
            >
              <Plus />
            </IconButton>
          </div>
          {!canInject ? (
            <div className="border-b border-border-subtle bg-warning/wash px-3 py-1.5 text-body-sm text-warning">
              Connect to an agent session to inject phrases
            </div>
          ) : null}
          <Command shouldFilter={false} loop className="bg-transparent">
            <div className="relative">
              <Search className="pointer-events-none absolute left-4 top-1/2 z-sticky h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <CommandInput
                ref={searchInputRef}
                value={search}
                onValueChange={setSearch}
                placeholder="Search phrases..."
                aria-label="Search quick phrases"
                className="h-10 pl-8 text-body-md"
              />
            </div>
            <CommandList className="max-h-64">
              {!data || phrases.length === 0 ? (
                <AsyncBoundary
                  query={phrasesQuery}
                  thing="phrases"
                  className="m-2"
                  isEmpty={() => true}
                  empty={
                    <p className="px-3 py-4 text-center text-body-sm text-muted-foreground">
                      No phrases yet
                    </p>
                  }
                >
                  {() => null}
                </AsyncBoundary>
              ) : (
                <>
                  <CommandEmpty>No matching phrases</CommandEmpty>
                  <CommandGroup className="p-0">
                    {filteredPhrases.map((phrase) => (
                      <CommandItem
                        key={phrase.id}
                        value={phrase.id}
                        onSelect={() => handleSelect(phrase)}
                        className="border-b border-border-subtle p-0 last:border-b-0 data-[selected=true]:bg-surface-selected"
                      >
                        <PhraseRow
                          phrase={phrase}
                          canInject={canInject}
                          isPending={actions.injectPhrase.isPending}
                          onInject={(submit) => handleInject(phrase, submit)}
                          onFill={() => handleFill(phrase)}
                          onEdit={() =>
                            startEditing({
                              id: phrase.id,
                              label: phrase.label ?? "",
                              text: phrase.text,
                            })
                          }
                          onDelete={() => setDeleting(phrase)}
                        />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
          {actions.injectPhrase.error && !filling ? (
            <Alert
              title="Couldn’t send the phrase."
              error={actions.injectPhrase.error}
              className="m-2"
            />
          ) : null}
          {/* Inside the popover's tree, so confirming leaves it open. */}
          <ConfirmDialog
            open={deleting !== null}
            onOpenChange={(next) => {
              if (!next) setDeleting(null);
            }}
            returnFocus={searchInputRef}
            title={`Delete “${deleting?.label || deleting?.text.slice(0, 40) || ""}”?`}
            description="The phrase is removed for every agent. This cannot be undone."
            confirmLabel="Delete phrase"
            errorTitle="Couldn’t delete the phrase."
            onConfirm={async () => {
              if (!deleting) return;
              await actions.deletePhrase.mutateAsync(deleting.id);
              toast.success("Phrase deleted.");
            }}
          />
        </PopoverContent>
      </Popover>

      <EditPhraseDialog
        editing={editing}
        onClose={() => setEditing(null)}
        onSave={handleSave}
        onChange={setEditing}
        isSaving={actions.isSaving}
        error={
          editing?.id ? actions.updatePhrase.error : actions.createPhrase.error
        }
        detectedArgs={editingDetectedArgs}
      />

      <FillVariablesDialog
        filling={filling}
        onClose={() => setFilling(null)}
        onFillChange={setFilling}
        onInject={handleInjectWithArgs}
        isPending={actions.injectPhrase.isPending}
        error={actions.injectPhrase.error}
        requiredMissing={fillingRequiredMissing}
      />
    </>
  );
}
