import { useCallback, useEffect, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/lib/api";
import { IDE_LABELS, IDE_TYPES, type IdeType } from "@/lib/ide-types";
import { Alert } from "@/components/ui/alert";
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
  const [error, setError] = useState<unknown>();
  const [loadError, setLoadError] = useState<unknown>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setIdes(enabledIdes);
  }, [enabledIdes]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    void api<IdeSettingsResponse>("/api/v1/app/settings/ides")
      .then((data) => {
        if (cancelled) return;
        setIdes(data.enabledIdes);
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

  const toggleIde = useCallback(
    async (ide: IdeType) => {
      setError(undefined);

      const next = ides.includes(ide)
        ? ides.filter((item) => item !== ide)
        : [...ides, ide];

      setIdes(next);
      onChange(next);

      try {
        const data = await api<IdeSettingsResponse>(
          "/api/v1/app/settings/ides",
          {
            method: "POST",
            body: JSON.stringify({ enabledIdes: next }),
          }
        );
        setIdes(data.enabledIdes);
        onChange(data.enabledIdes);
      } catch (err) {
        setIdes(ides);
        onChange(ides);
        setError(err);
      }
    },
    [ides, onChange]
  );

  if (loading || loadError) {
    return (
      <div className="max-w-lg p-6">
        {loadError ? (
          <LoadError
            thing="IDE settings"
            error={loadError}
            retrying={loading}
            onRetry={() => setAttempt((count) => count + 1)}
          />
        ) : (
          <LoadingSkeleton label="Loading IDE settings…" />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <div>
        <div className="mb-1.5 section-label">Available IDEs</div>
        <p className="mb-3 max-w-2xl text-body-md text-muted-foreground">
          Choose which IDEs appear in the &ldquo;Open in IDE&rdquo; button on
          agent cards. Only enable IDEs you actually have installed locally. The
          button is hidden when accessing Dispatch from a non-loopback host.
        </p>
      </div>

      <div className="max-w-lg space-y-2">
        {IDE_TYPES.map((ide) => {
          const checked = ides.includes(ide);
          return (
            <OptionCard key={ide} label={IDE_LABELS[ide]}>
              <Checkbox
                checked={checked}
                onCheckedChange={() => void toggleIde(ide)}
                data-testid={`ide-toggle-${ide}`}
              />
            </OptionCard>
          );
        })}
      </div>

      {error ? <Alert title="Couldn’t save changes." error={error} /> : null}
    </div>
  );
}
