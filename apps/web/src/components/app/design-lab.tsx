import { useEffect, useState } from "react";

import { DiffStatBadge } from "@/components/app/diff-stat-badge";
import type { DiffStats } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TooltipProvider } from "@/components/ui/tooltip";
import { THEMES, useTheme, type ThemeId } from "@/hooks/use-theme";

function ThemePicker({
  theme,
  setTheme,
}: {
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="mr-1 text-xs uppercase tracking-wide text-muted-foreground">
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

function buildDiffStats(
  added: number,
  deleted: number,
  files: number
): DiffStats {
  return {
    added,
    deleted,
    files,
    computedAt: Date.now(),
  };
}

function clampCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function DemoField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="space-y-2">
      <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </div>
      <Input
        type="number"
        min={0}
        value={String(value)}
        onChange={(event) => onChange(clampCount(Number(event.target.value)))}
        className="h-10 bg-background/70"
      />
    </label>
  );
}

export function DesignLab() {
  const { theme, setTheme } = useTheme();
  const [stats, setStats] = useState<DiffStats>(() => buildDiffStats(12, 3, 2));

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent =
      "html, body, #root { overflow: auto !important; height: auto !important; }";
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, []);

  const applyStats = (added: number, deleted: number, files: number) => {
    setStats(
      buildDiffStats(clampCount(added), clampCount(deleted), clampCount(files))
    );
  };

  const applyRandomJump = (size: "default" | "large" = "default") => {
    const nextAdded =
      size === "large"
        ? clampCount(stats.added + randomInt(180, 520))
        : clampCount(stats.added + randomInt(60, 220));
    const nextDeleted =
      size === "large"
        ? clampCount(stats.deleted + randomInt(120, 360))
        : clampCount(stats.deleted + randomInt(30, 140));
    const nextFiles = clampCount(
      Math.max(stats.files, 1) + randomInt(1, size === "large" ? 18 : 9)
    );

    applyStats(nextAdded, nextDeleted, nextFiles);
  };

  const applyRandomDrop = () => {
    applyStats(
      Math.max(0, stats.added - randomInt(40, 320)),
      Math.max(0, stats.deleted - randomInt(20, 180)),
      Math.max(1, stats.files - randomInt(1, 6))
    );
  };

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-[radial-gradient(circle_at_top,hsl(var(--muted))/0.55,transparent_45%),linear-gradient(180deg,hsl(var(--background)),hsl(var(--background))_60%,hsl(var(--muted))/0.22)] p-8">
        <div className="mx-auto max-w-[1400px]">
          <header className="mb-8">
            <h1 className="mb-1 text-3xl font-bold tracking-tight text-foreground">
              Design Lab
            </h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Interactive sandbox for the diff stat ticker. Use the controls to
              force small rolls, larger jumps, and four-digit values.
            </p>
          </header>

          <div className="sticky top-0 z-10 -mx-2 mb-8 flex flex-wrap items-center gap-6 rounded-xl border border-border bg-background/80 px-4 py-3 backdrop-blur">
            <ThemePicker theme={theme} setTheme={setTheme} />
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(360px,520px)_1fr]">
            <section className="rounded-[28px] border border-border/70 bg-card/70 p-6 shadow-[0_24px_80px_rgba(0,0,0,0.12)]">
              <div className="mb-4 flex items-center justify-between gap-4">
                <div>
                  <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                    Live Preview
                  </div>
                  <h2 className="mt-1 text-xl font-semibold text-foreground">
                    Diff stat badge
                  </h2>
                </div>
              </div>

              <div className="rounded-2xl border border-border/60 bg-background/55 p-4">
                <div className="relative space-y-2 rounded-xl border border-border/60 bg-background/35 px-3 py-3 text-xs text-muted-foreground">
                  <div className="absolute right-3 top-3">
                    <DiffStatBadge
                      diffStats={stats}
                      latestEventAt={null}
                      onRefresh={() => {}}
                    />
                  </div>
                  <div className="pr-32">
                    <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground/75">
                      Mock Agent
                    </div>
                    <div className="mt-1 text-sm font-semibold text-foreground">
                      diff ticker sandbox
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      This uses the real badge component and only changes the
                      raw incoming values.
                    </div>
                    {stats.added === 0 && stats.deleted === 0 ? (
                      <div className="mt-2 text-xs text-muted-foreground/80">
                        Badge hidden because both line counts are 0.
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </section>

            <section className="rounded-[28px] border border-border/70 bg-card/65 p-6">
              <div className="mb-5">
                <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                  Controls
                </div>
                <h2 className="mt-1 text-xl font-semibold text-foreground">
                  Force any change
                </h2>
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                <DemoField
                  label="Added"
                  value={stats.added}
                  onChange={(value) =>
                    applyStats(value, stats.deleted, stats.files)
                  }
                />
                <DemoField
                  label="Deleted"
                  value={stats.deleted}
                  onChange={(value) =>
                    applyStats(stats.added, value, stats.files)
                  }
                />
                <DemoField
                  label="Files"
                  value={stats.files}
                  onChange={(value) =>
                    applyStats(stats.added, stats.deleted, value)
                  }
                />
              </div>

              <div className="mt-6 flex flex-wrap gap-2">
                <Button variant="primary" onClick={() => applyRandomJump()}>
                  Random increase
                </Button>
                <Button variant="primary" onClick={() => applyRandomDrop()}>
                  Random decrease
                </Button>
                <Button
                  variant="default"
                  onClick={() => applyRandomJump("large")}
                >
                  Random large jump
                </Button>
              </div>

              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                <Button variant="ghost" onClick={() => applyStats(8, 1, 1)}>
                  Small roll
                </Button>
                <Button variant="ghost" onClick={() => applyStats(19, 4, 2)}>
                  Multi-digit roll
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => applyStats(248, 137, 11)}
                >
                  Hundreds jump
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => applyStats(412, 196, 17)}
                >
                  Downward run
                </Button>
                <Button variant="ghost" onClick={() => applyStats(999, 4, 7)}>
                  999 edge
                </Button>
                <Button variant="ghost" onClick={() => applyStats(1_000, 4, 7)}>
                  Four digits
                </Button>
                <Button variant="ghost" onClick={() => applyStats(12, 3, 2)}>
                  Reset
                </Button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
