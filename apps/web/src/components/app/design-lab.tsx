import { useEffect, useState } from "react";
import { THEMES, useTheme, type ThemeId } from "@/hooks/use-theme";
import { PathInput } from "@/components/app/path-input";

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
  const [cwd, setCwd] = useState("~/dev/apps/dispatch");

  const projectHistory = [
    "~/dev/apps/dispatch",
    "~/dev/apps/dispatch-ios",
    "~/dev/tools/codex",
    "~/work/customer-portal",
    "~/experiments/agent-sandbox",
  ];

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
            themes.
          </p>
        </header>

        <div className="sticky top-0 z-10 -mx-2 mb-8 rounded-xl border border-border bg-background/80 backdrop-blur px-4 py-3 flex items-center gap-6 flex-wrap">
          <ThemePicker theme={theme} setTheme={setTheme} />
        </div>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,520px)_minmax(0,1fr)]">
          <section className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">
                Working Directory Input
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Shared input used by agents, templates, and jobs.
              </p>
            </div>

            <PathInput
              value={cwd}
              onChange={setCwd}
              label="Working directory"
              history={projectHistory}
              historyMetadata={{
                "~/dev/apps/dispatch": {
                  label: "dispatch",
                  usageCount: 32,
                  iconUrl: "/icons/teal/brand-icon.svg",
                },
                "~/dev/apps/dispatch-ios": {
                  label: "dispatch-ios",
                  usageCount: 11,
                },
                "~/dev/tools/codex": {
                  label: "codex",
                  usageCount: 18,
                },
                "~/work/customer-portal": {
                  label: "customer-portal",
                  usageCount: 7,
                },
                "~/experiments/agent-sandbox": {
                  label: "agent-sandbox",
                  usageCount: 3,
                },
              }}
              onRemoveHistory={() => undefined}
              data-testid="design-lab-path-input"
              historyItemTestId="design-lab-path-option"
            />
          </section>

          <section className="space-y-3 text-sm text-muted-foreground">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              Interaction Targets
            </h2>
            <div className="rounded-md border border-border bg-card/50 p-4">
              <ul className="list-disc space-y-2 pl-5">
                <li>
                  Tab accepts the inline completion without adding a slash.
                </li>
                <li>Arrow up/down moves through project rows.</li>
                <li>Enter or Space selects the highlighted project.</li>
                <li>
                  Frequently used projects sort above recent-but-rare ones.
                </li>
                <li>Known projects can render as compact names with icons.</li>
              </ul>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
