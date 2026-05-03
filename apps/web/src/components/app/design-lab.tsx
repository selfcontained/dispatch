import { useEffect, useState } from "react";

import { DiffStatBadge } from "@/components/app/diff-stat-badge";
import type { DiffStats } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { TooltipProvider } from "@/components/ui/tooltip";
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

const BASE_DIFF_STATS: DiffStats = {
  added: 24,
  deleted: 8,
  files: 3,
  computedAt: Date.now(),
};

function cloneDiffStats(diffStats: DiffStats): DiffStats {
  return {
    ...diffStats,
    computedAt: Date.now(),
  };
}

export function DesignLab() {
  const { theme, setTheme } = useTheme();
  const [diffStats, setDiffStats] = useState<DiffStats>(BASE_DIFF_STATS);
  const [autoplay, setAutoplay] = useState(false);

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent =
      "html, body, #root { overflow: auto !important; height: auto !important; }";
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, []);

  useEffect(() => {
    if (!autoplay) return;

    const interval = window.setInterval(() => {
      setDiffStats((current) => {
        const nextAdded = Math.max(
          0,
          current.added +
            Math.floor(Math.random() * 15) -
            Math.floor(Math.random() * 6)
        );
        const nextDeleted = Math.max(
          0,
          current.deleted +
            Math.floor(Math.random() * 10) -
            Math.floor(Math.random() * 5)
        );

        return cloneDiffStats({
          added: nextAdded,
          deleted: nextDeleted,
          files: Math.max(
            1,
            current.files +
              Math.floor(Math.random() * 3) -
              Math.floor(Math.random() * 2)
          ),
          computedAt: current.computedAt,
        });
      });
    }, 1400);

    return () => window.clearInterval(interval);
  }, [autoplay]);

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-[1400px] mx-auto">
        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1">
            Design Lab
          </h1>
          <p className="text-sm text-muted-foreground">
            Sandbox for previewing component variations against different
            themes. Diff stat ticker prototype below uses fake agent data.
          </p>
        </header>

        <div className="sticky top-0 z-10 -mx-2 mb-8 rounded-xl border border-border bg-background/80 backdrop-blur px-4 py-3 flex items-center gap-6 flex-wrap">
          <ThemePicker theme={theme} setTheme={setTheme} />
        </div>

        <TooltipProvider delayDuration={120}>
          <Card className="border-border/70">
            <CardHeader>
              <CardTitle>Diff Stat Ticker</CardTitle>
              <CardDescription>
                Prototype for animating added and deleted line counts as
                incremental ticker values instead of a static flash.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex flex-wrap items-center gap-3">
                <div className="rounded-2xl border border-border/80 bg-background/80 px-4 py-3">
                  <DiffStatBadge
                    diffStats={diffStats}
                    latestEventAt={new Date(
                      diffStats.computedAt + 5_000
                    ).toISOString()}
                    onRefresh={() => {
                      setDiffStats((current) => cloneDiffStats(current));
                    }}
                  />
                </div>
                <div className="grid gap-1 text-xs text-muted-foreground">
                  <div className="font-mono text-foreground tabular-nums">
                    +{diffStats.added} −{diffStats.deleted} across{" "}
                    {diffStats.files} files
                  </div>
                  <div>
                    Refresh keeps the current values, while the controls below
                    push simulated diff updates through the shared badge.
                  </div>
                </div>
              </div>

              <div
                className="flex flex-wrap items-center gap-2"
                data-testid="diff-ticker-controls"
              >
                <Button
                  size="sm"
                  variant="ghost-primary"
                  data-testid="diff-ticker-bump-small"
                  onClick={() =>
                    setDiffStats((current) =>
                      cloneDiffStats({
                        ...current,
                        added: current.added + 9,
                        deleted: current.deleted + 2,
                        files: Math.max(current.files, 3),
                      })
                    )
                  }
                >
                  Small bump
                </Button>
                <Button
                  size="sm"
                  variant="ghost-primary"
                  data-testid="diff-ticker-bump-large"
                  onClick={() =>
                    setDiffStats((current) =>
                      cloneDiffStats({
                        ...current,
                        added: current.added + 34,
                        deleted: current.deleted + 11,
                        files: current.files + 2,
                      })
                    )
                  }
                >
                  Large bump
                </Button>
                <Button
                  size="sm"
                  variant="ghost-destructive"
                  data-testid="diff-ticker-pullback"
                  onClick={() =>
                    setDiffStats((current) =>
                      cloneDiffStats({
                        ...current,
                        added: Math.max(4, current.added - 18),
                        deleted: Math.max(1, current.deleted - 6),
                        files: Math.max(1, current.files - 1),
                      })
                    )
                  }
                >
                  Pull back
                </Button>
                <Button
                  size="sm"
                  data-testid="diff-ticker-reset"
                  onClick={() => setDiffStats(cloneDiffStats(BASE_DIFF_STATS))}
                >
                  Reset
                </Button>
                <label className="ml-2 inline-flex items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox
                    checked={autoplay}
                    data-testid="diff-ticker-autoplay"
                    onCheckedChange={(checked) => setAutoplay(checked === true)}
                  />
                  Autoplay
                </label>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-xl border border-border/70 bg-background/50 p-4">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    Added
                  </div>
                  <div className="mt-2 font-mono text-3xl tabular-nums text-status-working">
                    +{diffStats.added}
                  </div>
                </div>
                <div className="rounded-xl border border-border/70 bg-background/50 p-4">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    Deleted
                  </div>
                  <div className="mt-2 font-mono text-3xl tabular-nums text-status-blocked">
                    −{diffStats.deleted}
                  </div>
                </div>
                <div className="rounded-xl border border-border/70 bg-background/50 p-4">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    Files
                  </div>
                  <div className="mt-2 font-mono text-3xl tabular-nums text-foreground">
                    {diffStats.files}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TooltipProvider>
      </div>
    </div>
  );
}
