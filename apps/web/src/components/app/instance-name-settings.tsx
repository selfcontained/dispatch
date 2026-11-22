import { useCallback, useEffect, useRef, useState } from "react";

import { useInstanceName } from "@/hooks/use-instance-name";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";

export function InstanceNameSettings(): JSX.Element {
  const {
    instanceName,
    setInstanceName,
    isSaving,
    saveError,
    didSave,
    clearSaveState,
  } = useInstanceName();
  const [draft, setDraft] = useState(instanceName);
  const inputRef = useRef<HTMLInputElement>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showSaved, setShowSaved] = useState(false);

  // Sync draft when the stored value loads/changes (but not while the user is editing)
  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setDraft(instanceName);
    }
  }, [instanceName]);

  // Revert draft on save error
  useEffect(() => {
    if (saveError) {
      setDraft(instanceName);
    }
  }, [saveError, instanceName]);

  // Show brief "Saved" confirmation
  useEffect(() => {
    if (didSave) {
      setShowSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => {
        setShowSaved(false);
        clearSaveState();
      }, 2000);
    }
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, [didSave, clearSaveState]);

  const save = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed !== instanceName) {
      setInstanceName(trimmed);
    }
    setDraft(trimmed);
  }, [draft, instanceName, setInstanceName]);

  return (
    <div>
      <Field
        id="instance-name"
        label="Instance name"
        hint="Give this Dispatch instance a name to distinguish it from others. Shown in the sidebar and browser tab."
        error={saveError ? "Couldn’t save changes. Try again." : null}
      >
        <div className="flex items-center gap-2">
          <Input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (saveError) clearSaveState();
            }}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                save();
                inputRef.current?.blur();
              }
            }}
            disabled={isSaving}
            placeholder="e.g. Production, Staging, Local"
            maxLength={100}
            className="w-full max-w-sm"
          />
          {showSaved && !saveError ? (
            <span role="status" className="text-body-sm text-muted-foreground">
              Saved
            </span>
          ) : null}
        </div>
      </Field>
    </div>
  );
}
