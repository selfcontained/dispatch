import { useCallback, useEffect, useRef, useState } from "react";
import { LayoutGroup, motion } from "framer-motion";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IconButton } from "@/components/ui/icon-button";
import { RadioIndicator } from "@/components/app/radio-indicator";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SettingsGroup } from "@/components/app/settings-layout";
import { Panel, panelFrame } from "@/components/ui/card";
import { useAutoSave } from "@/hooks/use-auto-save";
import { Alert } from "@/components/ui/alert";
import { LoadError } from "@/components/ui/async-boundary";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field } from "@/components/ui/field";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";

type Personality = {
  id: string;
  name: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
};

type ListResponse = {
  personalities: Personality[];
  activeId: string | null;
};

type FormState = { name: string; prompt: string };
type EditingState =
  | { mode: "create"; form: FormState }
  | { mode: "edit"; id: string; form: FormState }
  | null;

const NAME_MAX = 80;
const PROMPT_MAX = 1000;

export function PersonalitySettings(): JSX.Element {
  const [personalities, setPersonalities] = useState<Personality[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<{ title: string; error: unknown }>();
  const [loadError, setLoadError] = useState<unknown>();
  const [invalid, setInvalid] = useState<{ name?: string; prompt?: string }>(
    {}
  );
  const [deleting, setDeleting] = useState<Personality | null>(null);
  const [editing, setEditing] = useState<EditingState>(null);
  const [submitting, setSubmitting] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Stable identity for the form session — changes whenever the form
  // mounts/transitions (open create, switch between editing different
  // personalities). Drives the focus effect below.
  const formSessionKey = !editing
    ? null
    : editing.mode === "create"
      ? "create"
      : `edit:${editing.id}`;

  // Move focus into the name field when the form opens, so keyboard/AT
  // users get a clear insertion point. Without this, the row→form swap
  // drops focus to <body>.
  useEffect(() => {
    if (!formSessionKey) return;
    nameInputRef.current?.focus();
  }, [formSessionKey]);

  const autoSave = useAutoSave<string | null, "active">(async (_, id) => {
    await api<{ activeId: string | null }>("/api/v1/personalities/active", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    setActiveId(id);
  });
  const { save: saveSetting, clear: clearSave } = autoSave;
  const shownActiveId = autoSave.value("active", activeId);

  const refresh = useCallback(async () => {
    try {
      const data = await api<ListResponse>("/api/v1/personalities");
      setPersonalities(data.personalities);
      setActiveId(data.activeId);
      setLoadError(undefined);
      setFailure(undefined);
      clearSave("active");
    } catch (err) {
      setLoadError(err);
    } finally {
      setLoading(false);
    }
  }, [clearSave]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const startCreate = useCallback(() => {
    setInvalid({});
    setFailure(undefined);
    setEditing({ mode: "create", form: { name: "", prompt: "" } });
  }, []);

  const startEdit = useCallback((personality: Personality) => {
    setInvalid({});
    setFailure(undefined);
    setEditing({
      mode: "edit",
      id: personality.id,
      form: { name: personality.name, prompt: personality.prompt },
    });
  }, []);

  const cancelEdit = useCallback(() => {
    setEditing(null);
    setInvalid({});
    setFailure(undefined);
  }, []);

  const submitForm = useCallback(async () => {
    if (!editing) return;
    const name = editing.form.name.trim();
    const prompt = editing.form.prompt;
    const missing = {
      name: name ? undefined : "Enter a name.",
      prompt: prompt.trim() ? undefined : "Enter a prompt.",
    };
    setInvalid(missing);
    setFailure(undefined);
    if (missing.name || missing.prompt) {
      if (missing.name) nameInputRef.current?.focus();
      return;
    }

    setSubmitting(true);
    try {
      if (editing.mode === "create") {
        await api<{ personality: Personality }>("/api/v1/personalities", {
          method: "POST",
          body: JSON.stringify({ name, prompt }),
        });
      } else {
        await api<{ personality: Personality }>(
          `/api/v1/personalities/${editing.id}`,
          {
            method: "PATCH",
            body: JSON.stringify({ name, prompt }),
          }
        );
      }
      setEditing(null);
      await refresh();
    } catch (err) {
      setFailure({ title: "Couldn’t save the personality.", error: err });
    } finally {
      setSubmitting(false);
    }
  }, [editing, refresh]);

  const toggleActive = useCallback(
    (id: string) => {
      setFailure(undefined);
      void saveSetting("active", shownActiveId === id ? null : id);
    },
    [saveSetting, shownActiveId]
  );

  const deletePersonality = useCallback(
    async (personality: Personality) => {
      await api(`/api/v1/personalities/${personality.id}`, {
        method: "DELETE",
      });
      toast.success(`Personality “${personality.name}” deleted.`);
      await refresh();
    },
    [refresh]
  );

  const renderFormCard = () => {
    if (!editing) return null;
    return (
      <Panel data-testid="personality-form">
        <Field
          id="personality-name"
          label="Name"
          error={invalid.name}
          className="mb-3"
        >
          <Input
            ref={nameInputRef}
            value={editing.form.name}
            maxLength={NAME_MAX}
            placeholder="e.g. Friendly, Pirate, Performance focused"
            onChange={(e) => {
              setInvalid((current) => ({ ...current, name: undefined }));
              setEditing({
                ...editing,
                form: { ...editing.form, name: e.target.value },
              });
            }}
            disabled={submitting}
            className="max-w-md"
          />
        </Field>
        <Field
          id="personality-prompt"
          label="Prompt"
          error={invalid.prompt}
          hint={`${editing.form.prompt.length} / ${PROMPT_MAX}`}
          className="mb-3"
        >
          <Textarea
            value={editing.form.prompt}
            maxLength={PROMPT_MAX}
            placeholder="Text to append to every agent's system prompt at launch."
            onChange={(e) => {
              setInvalid((current) => ({ ...current, prompt: undefined }));
              setEditing({
                ...editing,
                form: { ...editing.form, prompt: e.target.value },
              });
            }}
            disabled={submitting}
            className="min-h-32 resize-y"
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={cancelEdit}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            variant="primary"
            onClick={() => void submitForm()}
            pending={submitting}
            data-testid="personality-save"
          >
            {editing.mode === "create" ? "Create" : "Save"}
          </Button>
        </div>
      </Panel>
    );
  };

  const renderRow = (personality: Personality) => {
    const isActive = personality.id === shownActiveId;
    return (
      <div
        className={cn(
          panelFrame,
          "flex flex-wrap items-start gap-3 p-3 transition-colors sm:flex-nowrap",
          isActive
            ? "border-primary bg-surface-selected"
            : "hover:border-muted-foreground/line"
        )}
      >
        <IconButton
          onClick={() => toggleActive(personality.id)}
          aria-pressed={isActive}
          label={
            isActive
              ? `Deactivate ${personality.name}`
              : `Activate ${personality.name}`
          }
          className="-m-2"
          data-testid={`personality-toggle-${personality.id}`}
        >
          <RadioIndicator selected={isActive} className="mt-0" />
        </IconButton>
        <div className="min-w-0 flex-1">
          <div className="text-body-md font-medium text-foreground">
            {personality.name}
          </div>
          <p className="mt-1 line-clamp-2 text-body-sm text-muted-foreground">
            {personality.prompt}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => startEdit(personality)}
          >
            Edit
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            tone="danger"
            onClick={() => setDeleting(personality)}
          >
            Delete
          </Button>
        </div>
      </div>
    );
  };

  const isCreating = editing?.mode === "create";

  return (
    <SettingsGroup
      title="Personalities"
      description="Add text to every system prompt at launch. Use it for voice or preferences. Not used for review personas or jobs."
      status={autoSave.status("active")}
    >
      {loadError ? (
        <LoadError
          thing="personalities"
          error={loadError}
          retrying={loading}
          onRetry={() => {
            setLoading(true);
            void refresh();
          }}
        />
      ) : null}
      {failure ? <Alert {...failure} /> : null}

      <LayoutGroup>
        {!editing ? (
          <div>
            <Button
              type="button"
              size="sm"
              onClick={startCreate}
              data-testid="personality-new"
            >
              New personality
            </Button>
          </div>
        ) : null}

        {isCreating ? (
          <motion.div
            layout
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          >
            {renderFormCard()}
          </motion.div>
        ) : null}

        {loading && personalities.length === 0 && !loadError ? (
          <LoadingSkeleton label="Loading personalities…" rowClassName="h-16" />
        ) : !loading && !loadError && !editing && !personalities.length ? (
          <p className="text-body-sm text-muted-foreground">
            No personalities yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="personality-list">
            {personalities.map((personality) => {
              const isEditingThis =
                editing?.mode === "edit" && editing.id === personality.id;
              return (
                <motion.li
                  key={personality.id}
                  layout
                  transition={{ duration: 0.22, ease: "easeOut" }}
                  data-testid={`personality-row-${personality.id}`}
                >
                  <motion.div
                    layout="position"
                    initial={false}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.15 }}
                    key={isEditingThis ? "form" : "row"}
                  >
                    {isEditingThis ? renderFormCard() : renderRow(personality)}
                  </motion.div>
                </motion.li>
              );
            })}
          </ul>
        )}
      </LayoutGroup>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete “${deleting?.name ?? ""}”?`}
        description="New agents stop getting this personality. This cannot be undone."
        confirmLabel="Delete personality"
        errorTitle="Couldn’t delete the personality."
        onConfirm={async () => {
          if (deleting) await deletePersonality(deleting);
        }}
      />
    </SettingsGroup>
  );
}
