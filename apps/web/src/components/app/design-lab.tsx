import { useEffect } from "react";
import { THEMES, useTheme, type ThemeId } from "@/hooks/use-theme";

// Canvas for one-off component experiments. Add sections below as needed and
// remove them once the work ships — this page intentionally stays empty
// between projects so it's always ready for the next variant exploration.

function ThemePicker({
  theme,
  setTheme,
}: {
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs text-muted-foreground uppercase tracking-wide mr-1">
        Theme
      </span>
      {THEMES.map((t) => (
        <button
          key={t.id}
          onClick={() => setTheme(t.id)}
          className={`group flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
            theme === t.id
              ? "border-primary bg-primary/10 text-foreground"
              : "border-border bg-card text-muted-foreground hover:text-foreground"
          }`}
          title={t.description}
        >
          <span className="flex gap-0.5">
            {t.swatches.slice(0, 3).map((swatch, i) => (
              <span
                key={i}
                className="h-3 w-3 rounded-sm border border-black/20"
                style={{ backgroundColor: swatch }}
              />
            ))}
          </span>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function DesignLab() {
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent =
      "html, body, #root { overflow: auto !important; height: auto !important; }";
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, []);

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-[1400px] mx-auto">
        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1">
            Design Lab
          </h1>
          <p className="text-sm text-muted-foreground">
            Sandbox for previewing component variations against different
            themes. Currently empty — add experiments as sections below.
          </p>
        </header>

        <div className="sticky top-0 z-10 -mx-2 mb-8 rounded-xl border border-border bg-background/80 backdrop-blur px-4 py-3 flex items-center gap-6 flex-wrap">
          <ThemePicker theme={theme} setTheme={setTheme} />
        </div>

        <div className="rounded-xl border border-dashed border-border bg-card/30 px-8 py-16 text-center">
          <p className="text-sm text-muted-foreground">
            No active experiments. Add a section to{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              apps/web/src/components/app/design-lab.tsx
            </code>{" "}
            to preview a component.
          </p>
        </div>
      </div>
    </div>
  );
}
