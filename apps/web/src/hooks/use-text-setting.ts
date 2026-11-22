import { useState, type ChangeEvent, type KeyboardEvent } from "react";

import type { useAutoSave } from "@/hooks/use-auto-save";
import type { SaveStatus } from "@/components/ui/setting-row";

/**
 * A text setting: saves on blur, and Enter blurs. An edit that fails to save
 * or to validate stays in the field, and Retry sends what is there now.
 */
export function useTextSetting<K extends string>({
  name,
  saved,
  autoSave,
  validate,
}: {
  name: K;
  saved: string;
  autoSave: ReturnType<typeof useAutoSave<string, K>>;
  validate?: (value: string) => string | undefined;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string>();

  const commit = () => {
    if (draft === null) return;
    const next = draft.trim();
    const found = validate?.(next);
    setProblem(found);
    if (found) return;
    if (next === autoSave.value(name, saved)) {
      // Already on its way: keep the draft in case that save fails.
      if (autoSave.status(name).state === "saving") return;
      setDraft(null);
      // Back at what is saved, so there is no failure left to retry.
      if (autoSave.status(name).state === "failed") autoSave.clear(name);
      return;
    }
    void autoSave.save(name, next).then(({ ok }) => {
      // Typing that carried on during the save stays.
      if (ok) setDraft((current) => (current === draft ? null : current));
    });
  };

  const status: SaveStatus = autoSave.status(name);
  return {
    problem,
    status: { ...status, retry: commit },
    inputProps: {
      value: draft ?? autoSave.value(name, saved),
      onChange: (event: ChangeEvent<HTMLInputElement>) => {
        setDraft(event.target.value);
        setProblem(undefined);
      },
      onBlur: commit,
      onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing)
          event.currentTarget.blur();
      },
    },
  };
}
