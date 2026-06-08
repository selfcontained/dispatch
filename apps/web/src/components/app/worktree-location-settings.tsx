import { useCallback, useEffect, useState } from "react";

import { RadioIndicator } from "@/components/app/radio-indicator";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

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
      <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
        Worktree location
      </div>
      <p className="mb-3 text-sm text-muted-foreground">
        Choose where git worktrees are created for new agents.
      </p>
      <div className="grid gap-2">
        {OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => void handleChange(opt.value)}
            disabled={saving}
            className={cn(
              "flex items-start gap-3 rounded-md border p-3 text-left transition-colors",
              worktreeLocation === opt.value
                ? "border-primary bg-primary/10"
                : "border-border hover:border-muted-foreground/30"
            )}
          >
            <RadioIndicator selected={worktreeLocation === opt.value} />
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">
                {opt.label}
              </div>
              <div className="text-xs text-muted-foreground">
                {opt.description}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
