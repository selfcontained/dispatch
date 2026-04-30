import { useCallback, useEffect, useRef, useState } from "react";
import { LayoutGroup, motion } from "framer-motion";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioIndicator } from "@/components/app/radio-indicator";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

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

const TEXTAREA_CLASSES =
  "w-full min-h-32 rounded-md border border-white/[0.12] bg-white/[0.04] backdrop-blur-md shadow-[inset_0_2px_6px_rgba(0,0,0,0.3)] px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-y";

export function PersonalitySettings(): JSX.Element {
  const [personalities, setPersonalities] = useState<Personality[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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

  const refresh = useCallback(async () => {
    try {
      const data = await api<ListResponse>("/api/v1/personalities");
      setPersonalities(data.personalities);
      setActiveId(data.activeId);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load personalities."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const startCreate = useCallback(() => {
    setEditing({ mode: "create", form: { name: "", prompt: "" } });
  }, []);

  const startEdit = useCallback((personality: Personality) => {
    setEditing({
      mode: "edit",
      id: personality.id,
      form: { name: personality.name, prompt: personality.prompt },
    });
  }, []);

  const cancelEdit = useCallback(() => {
    setEditing(null);
    setError(null);
  }, []);

  const submitForm = useCallback(async () => {
    if (!editing) return;
    const name = editing.form.name.trim();
    const prompt = editing.form.prompt;
    if (!name) {
      setError("Name is required.");
      return;
    }
    if (!prompt.trim()) {
      setError("Prompt is required.");
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
      setError(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSubmitting(false);
    }
  }, [editing, refresh]);

  const toggleActive = useCallback(
    async (id: string) => {
      const next = activeId === id ? null : id;
      const previous = activeId;
      setActiveId(next);
      try {
        await api<{ activeId: string | null }>("/api/v1/personalities/active", {
          method: "POST",
          body: JSON.stringify({ id: next }),
        });
      } catch (err) {
        setActiveId(previous);
        setError(
          err instanceof Error
            ? err.message
            : "Failed to set active personality."
        );
      }
    },
    [activeId]
  );

  const deletePersonality = useCallback(
    async (personality: Personality) => {
      const confirmed = window.confirm(
        `Delete personality "${personality.name}"? This cannot be undone.`
      );
      if (!confirmed) return;
      try {
        await api(`/api/v1/personalities/${personality.id}`, {
          method: "DELETE",
        });
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete.");
      }
    },
    [refresh]
  );

  const renderFormCard = () => {
    if (!editing) return null;
    return (
      <div
        className="rounded-md border border-border bg-muted/20 p-4"
        data-testid="personality-form"
      >
        <div className="mb-3">
          <label
            htmlFor="personality-name"
            className="mb-1.5 block text-[10px] uppercase tracking-widest text-muted-foreground"
          >
            Name
          </label>
          <Input
            id="personality-name"
            ref={nameInputRef}
            value={editing.form.name}
            maxLength={NAME_MAX}
            placeholder="e.g. Friendly, Pirate, Performance focused"
            onChange={(e) =>
              setEditing(
                editing
                  ? {
                      ...editing,
                      form: { ...editing.form, name: e.target.value },
                    }
                  : null
              )
            }
            disabled={submitting}
            className="max-w-md"
          />
        </div>
        <div className="mb-3">
          <label
            htmlFor="personality-prompt"
            className="mb-1.5 block text-[10px] uppercase tracking-widest text-muted-foreground"
          >
            Prompt
          </label>
          <textarea
            id="personality-prompt"
            value={editing.form.prompt}
            maxLength={PROMPT_MAX}
            placeholder="Text to append to every agent's system prompt at launch."
            onChange={(e) =>
              setEditing(
                editing
                  ? {
                      ...editing,
                      form: { ...editing.form, prompt: e.target.value },
                    }
                  : null
              )
            }
            disabled={submitting}
            className={TEXTAREA_CLASSES}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {editing.form.prompt.length} / {PROMPT_MAX}
          </p>
        </div>
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
            onClick={() => void submitForm()}
            disabled={submitting}
            data-testid="personality-save"
          >
            {editing.mode === "create" ? "Create" : "Save"}
          </Button>
        </div>
      </div>
    );
  };

  const renderRow = (personality: Personality) => {
    const isActive = personality.id === activeId;
    return (
      <div
        className={cn(
          "flex items-start gap-3 rounded-md border p-3 transition-colors",
          isActive
            ? "border-primary bg-primary/10"
            : "border-border hover:border-muted-foreground/30"
        )}
      >
        <button
          type="button"
          onClick={() => void toggleActive(personality.id)}
          aria-pressed={isActive}
          aria-label={
            isActive
              ? `Deactivate ${personality.name}`
              : `Activate ${personality.name}`
          }
          className="-m-2 flex h-9 w-9 shrink-0 items-center justify-center rounded transition-colors hover:bg-muted/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid={`personality-toggle-${personality.id}`}
        >
          <RadioIndicator selected={isActive} className="mt-0" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">
            {personality.name}
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            {personality.prompt}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
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
            onClick={() => void deletePersonality(personality)}
            className="text-destructive hover:text-destructive"
          >
            Delete
          </Button>
        </div>
      </div>
    );
  };

  const isCreating = editing?.mode === "create";

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <div>
        <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          Personalities
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Add text to every system prompt at launch. Use it for voice or
          preferences. Not used for review personas or scheduled jobs.
        </p>
      </div>

      {error ? (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      <LayoutGroup>
        {!editing ? (
          <div>
            <Button
              type="button"
              size="sm"
              variant="default"
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

        {loading && personalities.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : personalities.length === 0 && !editing ? (
          <p className="text-sm text-muted-foreground">
            No personalities yet. Create one to apply a custom voice or
            preferences to your agents.
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
    </div>
  );
}
