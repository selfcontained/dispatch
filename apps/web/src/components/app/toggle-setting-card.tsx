import type { ReactNode } from "react";

import { Checkbox } from "@/components/ui/checkbox";

interface ToggleSettingCardProps {
  /** Small uppercase label above the section copy. */
  eyebrow: string;
  /** Section copy explaining what the setting does. */
  description: ReactNode;
  /** Bold title on the toggle row. */
  label: ReactNode;
  /** Secondary line under the title explaining on/off behavior. */
  hint: ReactNode;
  /** data-testid for the checkbox. */
  testId: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Empty string renders nothing. */
  error: string;
}

/**
 * Presentational shell for a single server-owned boolean setting: eyebrow,
 * copy, one bordered checkbox row and an error line. Deliberately does not own
 * the state — callers bring their own hook, because they do not all use the
 * same one (`useOptimisticToggleSetting` for the atom/fetch-backed flags,
 * `useChatSurfaceSetting` for the React Query-backed one the tab bar reads).
 */
export function ToggleSettingCard({
  eyebrow,
  description,
  label,
  hint,
  testId,
  checked,
  onCheckedChange,
  error,
}: ToggleSettingCardProps): JSX.Element {
  return (
    <div className="p-6">
      <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
        {eyebrow}
      </div>
      <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
        {description}
      </p>
      <div className="max-w-lg">
        <label className="flex cursor-pointer items-center gap-3 rounded border border-border px-3 py-2.5 transition-colors hover:bg-muted/50">
          <Checkbox
            checked={checked}
            onCheckedChange={(next) => onCheckedChange(next === true)}
            data-testid={testId}
          />
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">{label}</div>
            <div className="text-xs text-muted-foreground">{hint}</div>
          </div>
        </label>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
