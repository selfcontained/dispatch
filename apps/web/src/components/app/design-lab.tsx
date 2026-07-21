import { useMemo } from "react";
import { THEMES, useTheme, type ThemeId } from "@/hooks/use-theme";
import { Diff, Hunk, markEdits, parseDiff, tokenize } from "react-diff-view";
import "react-diff-view/style/index.css";
import { refractor } from "refractor";
import tsx from "refractor/tsx";
import javascript from "refractor/javascript";

refractor.register(tsx);
refractor.register(javascript);

const refractorAdapter = {
  highlight(code: string, language: string) {
    return refractor.highlight(code, language).children;
  },
  registered(language: string) {
    return refractor.registered(language);
  },
};

const SAMPLE_DIFF = `diff --git a/apps/web/src/components/app/child-agent-row.tsx b/apps/web/src/components/app/child-agent-row.tsx
--- a/apps/web/src/components/app/child-agent-row.tsx
+++ b/apps/web/src/components/app/child-agent-row.tsx
@@ -38,8 +38,13 @@ export function ChildAgentRow({
   const isStopped = state === "stopped";
   const isReviewAgent = agent.role === "review";
+  const canOpenSubmittedReview =
+    isReviewAgent && agent.submittedReviewId != null;
+  const showReviewActivity =
+    isReviewAgent && agent.status === "running" && isInitialReviewActive;
   const displayName = agent.persona ?? agent.name;
-  const showReviewActivity = agent.status === "running";
+
+  // A submitted review becomes the durable source of review completion.
   const statusLabel = isStopped
     ? "Stopped"
     : agent.status === "error"
`;

function DiffPreview() {
  const parsed = useMemo(() => parseDiff(SAMPLE_DIFF), []);
  const file = parsed[0];

  const tokens = useMemo(() => {
    if (!file) return undefined;
    const enhancers = [markEdits(file.hunks)];
    try {
      return tokenize(file.hunks, {
        highlight: true,
        refractor: refractorAdapter,
        language: "tsx",
        enhancers,
      });
    } catch {
      return undefined;
    }
  }, [file]);

  if (!file) return null;

  return (
    <div className="changes-diff-view rounded-lg border border-border overflow-hidden text-xs">
      <div className="flex items-center gap-2 px-3 py-2 bg-card border-b border-border">
        <span className="font-mono text-muted-foreground">
          src/components/app/child-agent-row.tsx
        </span>
        <span className="text-status-done text-xs">+6</span>
        <span className="text-status-blocked text-xs">-1</span>
      </div>
      <Diff
        viewType="unified"
        diffType="modify"
        hunks={file.hunks}
        tokens={tokens}
      >
        {(hunks) =>
          hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)
        }
      </Diff>
    </div>
  );
}

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

  return (
    <div className="bg-background p-8">
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

        <section className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Diff View</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Unified diff with syntax highlighting and intra-line edits. Switch
              themes above to compare diff colors.
            </p>
          </div>
          <DiffPreview />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div className="rounded-md border border-border p-3 space-y-2">
              <span className="text-muted-foreground">--diff-add</span>
              <div
                className="h-6 rounded"
                style={{ background: "hsl(var(--diff-add))" }}
              />
              <div
                className="h-6 rounded"
                style={{ background: "hsl(var(--diff-add) / 0.22)" }}
              />
            </div>
            <div className="rounded-md border border-border p-3 space-y-2">
              <span className="text-muted-foreground">--diff-delete</span>
              <div
                className="h-6 rounded"
                style={{ background: "hsl(var(--diff-delete))" }}
              />
              <div
                className="h-6 rounded"
                style={{ background: "hsl(var(--diff-delete) / 0.22)" }}
              />
            </div>
            <div className="rounded-md border border-border p-3 space-y-2">
              <span className="text-muted-foreground">--status-working</span>
              <div
                className="h-6 rounded"
                style={{ background: "hsl(var(--status-working))" }}
              />
            </div>
            <div className="rounded-md border border-border p-3 space-y-2">
              <span className="text-muted-foreground">--status-blocked</span>
              <div
                className="h-6 rounded"
                style={{ background: "hsl(var(--status-blocked))" }}
              />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
