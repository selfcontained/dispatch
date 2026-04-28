import { useCallback, useEffect, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/lib/api";
import { IDE_LABELS, IDE_TYPES, type IdeType } from "@/lib/ide-types";

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
  const [error, setError] = useState("");

  useEffect(() => {
    setIdes(enabledIdes);
  }, [enabledIdes]);

  useEffect(() => {
    let cancelled = false;

    void api<IdeSettingsResponse>("/api/v1/app/settings/ides")
      .then((data) => {
        if (cancelled) return;
        setIdes(data.enabledIdes);
        onChange(data.enabledIdes);
        setError("");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Failed to load IDE settings."
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [onChange]);

  const toggleIde = useCallback(
    async (ide: IdeType) => {
      setError("");

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
        setError(
          err instanceof Error ? err.message : "Failed to save IDE settings."
        );
      }
    },
    [ides, onChange]
  );

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <div>
        <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          Available IDEs
        </div>
        <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
          Choose which IDEs appear in the &ldquo;Open in IDE&rdquo; button on
          agent cards. Only enable IDEs you actually have installed locally. The
          button is hidden when accessing Dispatch from a non-loopback host.
        </p>
      </div>

      <div className="max-w-lg space-y-2">
        {IDE_TYPES.map((ide) => {
          const checked = ides.includes(ide);
          return (
            <label
              key={ide}
              className="flex cursor-pointer items-center gap-3 rounded border border-border px-3 py-2.5 transition-colors hover:bg-muted/50"
            >
              <Checkbox
                checked={checked}
                onCheckedChange={() => void toggleIde(ide)}
                data-testid={`ide-toggle-${ide}`}
              />
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">
                  {IDE_LABELS[ide]}
                </div>
              </div>
            </label>
          );
        })}
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
