import { useCallback, useEffect, useRef, useState } from "react";

import { useInstanceName } from "@/hooks/use-instance-name";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

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
      <label
        htmlFor="instance-name"
        className="mb-1.5 block text-[10px] uppercase tracking-widest text-muted-foreground"
      >
        Instance name
      </label>
      <p className="mb-3 text-sm text-muted-foreground">
        Give this Dispatch instance a name to distinguish it from others. Shown
        in the sidebar and browser tab.
      </p>
      <div className="flex items-center gap-2">
        <Input
          id="instance-name"
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
          className={cn("w-full max-w-sm", saveError && "border-destructive")}
        />
        {showSaved && !saveError ? (
          <span className="text-xs text-muted-foreground">Saved</span>
        ) : null}
      </div>
      {saveError ? (
        <p className="mt-1.5 text-xs text-destructive">
          Failed to save. Please try again.
        </p>
      ) : null}
    </div>
  );
}
