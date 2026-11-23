import {
  type IconColorId,
  ICON_COLOR_OPTIONS,
  useIconColor,
} from "@/hooks/use-icon-color";
import { useAutoSave } from "@/hooks/use-auto-save";
import { DEFAULT_THEME_ID, type ThemeId, THEMES } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";
import { SettingsGroup } from "@/components/app/settings-layout";
import { RowButton } from "@/components/ui/row-button";
import { Badge } from "@/components/ui/badge";
import { SettingRow } from "@/components/ui/setting-row";

export function AppearanceSettings({
  theme,
  setTheme,
}: {
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
}): JSX.Element {
  const { iconColor, saveIconColor } = useIconColor();
  const autoSave = useAutoSave<IconColorId, "icon">((_, color) =>
    saveIconColor(color)
  );
  const displayColor = autoSave.value("icon", iconColor);

  return (
    <SettingsGroup title="Appearance">
      <SettingRow
        layout="group"
        label="Theme"
        description="Choose a color theme for the interface."
      >
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
                  <RowButton
                    key={t.id}
                    selected={theme === t.id}
                    aria-pressed={theme === t.id}
                    onClick={() => setTheme(t.id)}
                    className={cn(
                      "items-start gap-3 border p-3",
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
                          <Badge size="sm">Default</Badge>
                        )}
                      </div>
                      <div className="text-body-sm text-muted-foreground">
                        {t.description}
                      </div>
                    </div>
                  </RowButton>
                ))}
              </div>
            </div>
          );
        })}
      </SettingRow>
      <SettingRow
        layout="group"
        label="Icon color"
        description="Tells installations apart. Changing it reloads the page, and installed apps may need reinstalling for launcher icons to update."
        status={autoSave.status("icon")}
      >
        <div
          className="flex flex-wrap gap-2"
          role="radiogroup"
          aria-label="Icon color"
        >
          {ICON_COLOR_OPTIONS.map((c) => (
            <RowButton
              key={c.id}
              role="radio"
              aria-checked={displayColor === c.id}
              aria-label={c.label}
              onClick={() => {
                if (c.id !== displayColor) void autoSave.save("icon", c.id);
              }}
              className={cn(
                "w-14 flex-col gap-1 rounded-lg border-2 px-1 py-1.5 transition-all",
                displayColor === c.id
                  ? "border-foreground bg-foreground/tint hover:bg-foreground/tint"
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
            </RowButton>
          ))}
        </div>
      </SettingRow>
    </SettingsGroup>
  );
}
