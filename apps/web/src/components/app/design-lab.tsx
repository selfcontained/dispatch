import { SimulatedDefragTurn } from "./simulated-defrag-turn";
import { useSearchParams } from "react-router-dom";
import { CompactionComparison } from "./compaction-comparison";
import { DefragActivityCheckpoint } from "./defrag-activity-checkpoint";
import { FillCountStudy } from "./fill-count-study";
import { THEMES, useTheme, type ThemeId } from "@/hooks/use-theme";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RowButton } from "@/components/ui/row-button";
import { Hint } from "@/components/ui/tooltip";

function ThemePicker({
  theme,
  setTheme,
}: {
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="mr-1 section-label">Theme</span>
      {THEMES.map((t) => (
        <Hint key={t.id} label={t.description}>
          <RowButton
            onClick={() => setTheme(t.id)}
            className={`group w-auto rounded-lg border px-2 py-1.5 text-body-sm ${
              theme === t.id
                ? "border-primary bg-surface-selected text-foreground hover:bg-surface-selected"
                : "border-border bg-card text-muted-foreground hover:text-foreground"
            }`}
          >
            <span className="flex gap-0.5">
              {t.swatches.slice(0, 3).map((swatch, i) => (
                <span
                  key={i}
                  className="h-3 w-3 rounded-sm border border-media/tint-strong"
                  style={{ backgroundColor: swatch }}
                />
              ))}
            </span>
            {t.label}
          </RowButton>
        </Hint>
      ))}
    </div>
  );
}

export function DesignLab(): JSX.Element {
  const { theme, setTheme } = useTheme();
  const [params, setParams] = useSearchParams();
  const scene =
    params.get("turn-demo") === "1"
      ? "turn"
      : params.get("activity-defrag") === "1"
        ? "activity"
        : params.get("fill-count") === "1"
          ? "fills"
          : "compaction";
  return (
    <div className="bg-background min-h-full p-4 md:p-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <h1 className="text-display">Design Lab · Defrag</h1>
        <ThemePicker theme={theme} setTheme={setTheme} />
        <Tabs
          activationMode="manual"
          value={scene}
          onValueChange={(value) =>
            setParams((previous) => {
              const next = new URLSearchParams(previous);
              next.delete("turn-demo");
              if (value === "turn") next.set("turn-demo", "1");
              if (value === "activity") next.set("activity-defrag", "1");
              else next.delete("activity-defrag");
              if (value === "fills") next.set("fill-count", "1");
              else next.delete("fill-count");
              return next;
            })
          }
        >
          <TabsList aria-label="Defrag studies">
            <TabsTrigger value="turn">Simulated turn</TabsTrigger>
            <TabsTrigger value="compaction">Compaction</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
            <TabsTrigger value="fills">Fill count</TabsTrigger>
          </TabsList>
          <TabsContent value="turn" className="mt-6">
            <SimulatedDefragTurn />
          </TabsContent>
          <TabsContent value="compaction" className="mt-6">
            <CompactionComparison />
          </TabsContent>
          <TabsContent value="activity" className="mt-6">
            <DefragActivityCheckpoint />
          </TabsContent>
          <TabsContent value="fills" className="mt-6">
            <FillCountStudy />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
