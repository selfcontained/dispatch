import { useSearchParams } from "react-router-dom";
import { CompactionComparison } from "./compaction-comparison";
import { DefragActivityCheckpoint } from "./defrag-activity-checkpoint";
import { THEMES, useTheme, type ThemeId } from "@/hooks/use-theme";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

function ThemePicker({
  theme,
  setTheme,
}: {
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
}): JSX.Element {
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

export function DesignLab(): JSX.Element {
  const { theme, setTheme } = useTheme();
  const [params, setParams] = useSearchParams();
  const scene =
    params.get("activity-defrag") === "1" ? "activity" : "compaction";
  return (
    <div className="bg-background min-h-full p-4 md:p-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <h1 className="text-2xl font-semibold">Design Lab · Defrag</h1>
        <ThemePicker theme={theme} setTheme={setTheme} />
        <Tabs
          activationMode="manual"
          value={scene}
          onValueChange={(value) =>
            setParams((previous) => {
              const next = new URLSearchParams(previous);
              if (value === "activity") next.set("activity-defrag", "1");
              else next.delete("activity-defrag");
              return next;
            })
          }
        >
          <TabsList aria-label="Defrag studies">
            <TabsTrigger value="compaction">Compaction</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>
          <TabsContent value="compaction" className="mt-6">
            <CompactionComparison />
          </TabsContent>
          <TabsContent value="activity" className="mt-6">
            <DefragActivityCheckpoint />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
