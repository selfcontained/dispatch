import { useCallback, useEffect, useState } from "react";

import { RadioIndicator } from "@/components/app/radio-indicator";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { RowButton } from "@/components/ui/row-button";
import { Alert } from "@/components/ui/alert";
import { AsyncBoundary } from "@/components/ui/async-boundary";
import { LoadingSkeleton } from "@/components/ui/skeleton";

type WorktreeLocation = "sibling" | "nested";

const OPTIONS: Array<{
  value: WorktreeLocation;
  label: string;
  description: string;
}> = [
  {
    value: "sibling",
    label: "Sibling directories",
    description:
      "Worktrees are created next to the repo (e.g. ../repo-branch-name)",
  },
  {
    value: "nested",
    label: "Inside .dispatch/worktrees",
    description:
      "Worktrees are created inside the repo in .dispatch/worktrees/",
  },
];

export function WorktreeLocationSettings(): JSX.Element {
  const [worktreeLocation, setWorktreeLocation] =
    useState<WorktreeLocation>("sibling");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>();
  const [loadError, setLoadError] = useState<unknown>();
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void api<{ worktreeLocation: WorktreeLocation }>("/api/v1/agents/settings")
      .then((data) => {
        if (cancelled) return;
        setWorktreeLocation(data.worktreeLocation);
        setLoadError(undefined);
        setLoaded(true);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const handleChange = useCallback(async (value: WorktreeLocation) => {
    setWorktreeLocation(value);
    setSaveError(undefined);
    setSaving(true);
    try {
      await api<{ worktreeLocation: WorktreeLocation }>(
        "/api/v1/agents/settings",
        {
          method: "POST",
          body: JSON.stringify({ worktreeLocation: value }),
        }
      );
    } catch (err) {
      setWorktreeLocation(value === "sibling" ? "nested" : "sibling");
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  }, []);

  return (
    <div>
      <div className="mb-1.5 section-label">Worktree location</div>
      <p className="mb-3 text-body-md text-muted-foreground">
        Choose where git worktrees are created for new agents.
      </p>
      <AsyncBoundary
        query={{
          data: loaded ? worktreeLocation : undefined,
          error: loadError,
          isFetching: false,
          refetch: () => setAttempt((count) => count + 1),
        }}
        thing="the worktree location"
        loading={
          <LoadingSkeleton
            label="Loading the worktree location…"
            rows={2}
            rowClassName="h-16"
          />
        }
      >
        {() => (
          <div className="grid gap-2">
            {OPTIONS.map((opt) => (
              <RowButton
                key={opt.value}
                selected={worktreeLocation === opt.value}
                aria-pressed={worktreeLocation === opt.value}
                onClick={() => {
                  if (opt.value !== worktreeLocation)
                    void handleChange(opt.value);
                }}
                disabled={saving}
                className={cn(
                  "items-start gap-3 border p-3",
                  worktreeLocation === opt.value
                    ? "border-primary bg-surface-selected"
                    : "border-border hover:border-muted-foreground/line"
                )}
              >
                <RadioIndicator selected={worktreeLocation === opt.value} />
                <div className="min-w-0">
                  <div className="text-body-md font-medium text-foreground">
                    {opt.label}
                  </div>
                  <div className="text-body-sm text-muted-foreground">
                    {opt.description}
                  </div>
                </div>
              </RowButton>
            ))}
          </div>
        )}
      </AsyncBoundary>
      {saveError ? (
        <Alert
          title="Couldn’t save changes."
          error={saveError}
          className="mt-2"
        />
      ) : null}
    </div>
  );
}
