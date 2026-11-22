import { useCallback, useEffect, useState } from "react";

import { RadioIndicator } from "@/components/app/radio-indicator";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { RowButton } from "@/components/ui/row-button";

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

  useEffect(() => {
    let cancelled = false;
    void api<{ worktreeLocation: WorktreeLocation }>("/api/v1/agents/settings")
      .then((data) => {
        if (!cancelled) setWorktreeLocation(data.worktreeLocation);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleChange = useCallback(async (value: WorktreeLocation) => {
    setWorktreeLocation(value);
    setSaving(true);
    try {
      await api<{ worktreeLocation: WorktreeLocation }>(
        "/api/v1/agents/settings",
        {
          method: "POST",
          body: JSON.stringify({ worktreeLocation: value }),
        }
      );
    } catch {
      // revert on error
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
      <div className="grid gap-2">
        {OPTIONS.map((opt) => (
          <RowButton
            key={opt.value}
            aria-pressed={worktreeLocation === opt.value}
            onClick={() => void handleChange(opt.value)}
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
    </div>
  );
}
