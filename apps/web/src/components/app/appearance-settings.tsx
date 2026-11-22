import { useEffect, useState } from "react";

import { type IconColorId, ICON_COLOR_OPTIONS } from "@/hooks/use-icon-color";
import { DEFAULT_THEME_ID, type ThemeId, THEMES } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

export function AppearanceSettings({
  theme,
  setTheme,
  iconColor,
  setIconColor,
  isIconColorSaving,
  iconColorError,
  clearIconColorError,
}: {
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
  iconColor: IconColorId;
  setIconColor: (id: IconColorId) => void;
  isIconColorSaving: boolean;
  iconColorError: string | null;
  clearIconColorError: () => void;
}): JSX.Element {
  const [pendingColor, setPendingColor] = useState<IconColorId | null>(null);
  const displayColor = pendingColor ?? iconColor;

  useEffect(() => {
    if (iconColorError) {
      setPendingColor(null);
    }
  }, [iconColorError]);

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <div>
        <div className="mb-1.5 section-label">Theme</div>
        <p className="mb-3 text-body-md text-muted-foreground">
          Choose a color theme for the interface.
        </p>
        {(["dark", "light"] as const).map((mode) => {
          const items = THEMES.filter((t) => t.mode === mode);
          if (items.length === 0) return null;
          return (
            <div key={mode} className="mb-4 last:mb-0">
              <div className="mb-2 section-label">
                {mode === "dark" ? "Dark" : "Light"}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {items.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTheme(t.id)}
                    className={cn(
                      "flex items-start gap-3 rounded-md border p-3 text-left transition-colors",
                      theme === t.id
                        ? "border-primary bg-surface-selected"
                        : "border-border hover:border-muted-foreground/line"
                    )}
                  >
                    <div className="mt-0.5 flex gap-1">
                      {t.swatches.map((color, i) => (
                        <span
                          key={i}
                          className="block h-4 w-4 rounded-full border border-edge-subtle"
                          style={{ backgroundColor: color }}
                        />
                      ))}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <div className="text-body-md font-medium text-foreground">
                          {t.label}
                        </div>
                        {t.id === DEFAULT_THEME_ID && (
                          <span className="rounded-sm border border-border bg-surface-subtle px-1.5 py-0.5 text-label-xs font-medium uppercase tracking-wider text-muted-foreground">
                            Default
                          </span>
                        )}
                      </div>
                      <div className="text-body-sm text-muted-foreground">
                        {t.description}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div>
        <div className="mb-1.5 section-label">Icon Color</div>
        <p className="mb-3 text-body-md text-muted-foreground">
          Pick a color for the app icon to help distinguish multiple Dispatch
          installations.
        </p>
        <div
          className={cn(
            "flex flex-wrap gap-2",
            isIconColorSaving && "pointer-events-none opacity-60"
          )}
          role="radiogroup"
          aria-label="Icon color"
        >
          {ICON_COLOR_OPTIONS.map((c) => (
            <button
              key={c.id}
              role="radio"
              aria-checked={displayColor === c.id}
              aria-label={c.label}
              disabled={isIconColorSaving}
              onClick={() => {
                if (c.id !== iconColor) {
                  setPendingColor(c.id);
                  setIconColor(c.id);
                }
              }}
              className={cn(
                "flex w-14 flex-col items-center gap-1 rounded-lg border-2 px-1 py-1.5 transition-all",
                displayColor === c.id
                  ? "border-foreground bg-foreground/tint"
                  : "border-transparent hover:border-muted-foreground/line-strong hover:bg-surface-hover"
              )}
            >
              <img
                src={`/icons/${c.id}/brand-icon.svg`}
                alt=""
                className="h-7 w-7 object-contain"
              />
              <span
                className={cn(
                  "text-label-xs leading-none",
                  displayColor === c.id
                    ? "text-foreground"
                    : "text-muted-foreground"
                )}
              >
                {c.label}
              </span>
            </button>
          ))}
        </div>
        {iconColorError ? (
          <p className="mt-2 text-body-sm text-danger">
            {iconColorError}{" "}
            <button
              onClick={clearIconColorError}
              className="underline hover:no-underline"
            >
              Dismiss
            </button>
          </p>
        ) : (
          <p className="mt-2 text-body-sm text-faint">
            Changing the icon color will reload the page. PWA users may need to
            reinstall for launcher icons to update.
          </p>
        )}
      </div>
    </div>
  );
}
