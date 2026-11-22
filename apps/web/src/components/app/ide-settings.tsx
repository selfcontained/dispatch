import { useEffect, useRef, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/lib/api";
import { IDE_LABELS, IDE_TYPES, type IdeType } from "@/lib/ide-types";
import { SettingsGroup } from "@/components/app/settings-layout";
import { useAutoSave } from "@/hooks/use-auto-save";
import { LoadError } from "@/components/ui/async-boundary";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { OptionCard } from "@/components/ui/setting-row";

type IdeSettingsResponse = {
  enabledIdes: IdeType[];
};

type IdeSettingsProps = {
  enabledIdes: IdeType[];
  onChange: (ides: IdeType[]) => void;
};

export function IdeSettings({
  enabledIdes,
  onChange,
}: IdeSettingsProps): JSX.Element {
  const [ides, setIdes] = useState<IdeType[]>(enabledIdes);
  const [loading, setLoading] = useState(true);
  // What the server last confirmed, read by a save when its turn comes.
  const savedRef = useRef(enabledIdes);
  const [loadError, setLoadError] = useState<unknown>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setIdes(enabledIdes);
    savedRef.current = enabledIdes;
  }, [enabledIdes]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    void api<IdeSettingsResponse>("/api/v1/app/settings/ides")
      .then((data) => {
        if (cancelled) return;
        setIdes(data.enabledIdes);
        savedRef.current = data.enabledIdes;
        onChange(data.enabledIdes);
        setLoadError(undefined);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [onChange, attempt]);

  const autoSave = useAutoSave<boolean, IdeType>(async (ide, enabled) => {
    const others = savedRef.current.filter((item) => item !== ide);
    const data = await api<IdeSettingsResponse>("/api/v1/app/settings/ides", {
      method: "POST",
      body: JSON.stringify({
        enabledIdes: enabled ? [...others, ide] : others,
      }),
    });
    savedRef.current = data.enabledIdes;
    setIdes(data.enabledIdes);
    onChange(data.enabledIdes);
  });

  return (
    <SettingsGroup
      title="Available IDEs"
      description="Choose which IDEs appear in the “Open in IDE” button on agent cards. Only enable IDEs you have installed locally. The button is hidden when Dispatch is opened from a non-loopback host."
    >
      {loadError ? (
        <LoadError
          thing="IDE settings"
          error={loadError}
          retrying={loading}
          onRetry={() => setAttempt((count) => count + 1)}
        />
      ) : loading ? (
        <LoadingSkeleton label="Loading IDE settings…" />
      ) : (
        IDE_TYPES.map((ide) => {
          const checked = autoSave.value(ide, ides.includes(ide));
          return (
            <OptionCard
              key={ide}
              label={IDE_LABELS[ide]}
              status={autoSave.status(ide)}
            >
              <Checkbox
                checked={checked}
                onCheckedChange={() => void autoSave.save(ide, !checked)}
                data-testid={`ide-toggle-${ide}`}
              />
            </OptionCard>
          );
        })
      )}
    </SettingsGroup>
  );
}
