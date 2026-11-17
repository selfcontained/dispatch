import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DefragPreviewGrid } from "./compaction-comparison";
import { ActivityBlock } from "./chat/turn/activity-block";
import {
  activityCategory,
  type ActivityCategory,
} from "./chat/turn/activity-category";
import type { Step } from "./chat/turn/contracts";

const SCRIPT = [
  { label: "Reviewing the change", kind: "think", delay: 1800 },
  { label: "functions.exec", kind: "execute", delay: 1200 },
  { label: "git diff --stat", kind: "execute", nested: true, delay: 2200 },
  { label: "Read response-placeholder.tsx", kind: "read", delay: 2200 },
  { label: "Checking nested command handling", kind: "think", delay: 1800 },
  { label: "pnpm run check", kind: "execute", delay: 3000 },
  {
    label: "Review notes",
    kind: "note",
    delay: 1800,
    text: "Nested commands now receive their own pieces. I’m checking the transition and running the remaining verification.",
  },
  { label: "compacting context", kind: "compaction", delay: 1000 },
  { label: "Resuming verification", kind: "think", delay: 1800 },
  { label: "functions.exec", kind: "execute", delay: 1200 },
  {
    label: "pnpm test response-placeholder",
    kind: "execute",
    nested: true,
    delay: 3000,
  },
  { label: "Check the mobile preview", kind: "fetch", delay: 2200 },
  {
    label: "Write the result",
    kind: "note",
    delay: 2400,
    text: "The checks passed. Nested calls are counted once, reduced motion is respected, and the grid keeps its history when normal work resumes.",
  },
] satisfies Array<{
  label: string;
  kind: string;
  delay: number;
  nested?: boolean;
  text?: string;
}>;
const COMPACTION = SCRIPT.findIndex((event) => event.kind === "compaction");

function traceAt(index: number, times: number[]): Step[] {
  const steps: Step[] = [];
  SCRIPT.slice(0, index + 1).forEach((event, i) => {
    const current = i === index;
    const step: Step = {
      id: `demo-${i}`,
      kind: event.kind,
      label: event.label,
      status: current ? "running" : "ok",
      startedAt: times[i]!,
      ...(current ? {} : { endedAt: times[i + 1] ?? times[i]! }),
      detail: { input: { command: event.label } },
    };
    if ("nested" in event && event.nested) {
      const parent = steps.at(-1)!;
      parent.children = [step];
      if (!current) parent.endedAt = times[i + 1] ?? times[i]!;
      if (current) {
        parent.status = "running";
        delete parent.endedAt;
      }
    } else steps.push(step);
  });
  return steps;
}

export function SimulatedDefragTurn() {
  const [times, setTimes] = useState(() => [Date.now()]);
  const startedAt = times[0]!;
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [categories, setCategories] = useState<ActivityCategory[]>(["think"]);
  const compacting = index === COMPACTION;
  const done = index >= SCRIPT.length;
  const steps = traceAt(index, times);
  const advance = () => {
    const next = index + 1;
    setIndex(next);
    setTimes((previous) => [...previous, Date.now()]);
    if (next < SCRIPT.length && next !== COMPACTION) {
      const event = SCRIPT[next]!;
      const step: Step = {
        id: `demo-${next}`,
        kind: event.kind,
        label: event.label,
        status: "running",
        startedAt: 0,
        detail: { input: { command: event.label } },
      };
      setCategories((previous) => [
        ...previous,
        activityCategory(step),
        ...("text" in event ? ["write" as const] : []),
      ]);
    }
  };
  useEffect(() => {
    if (!playing || done) return;
    const timer = window.setTimeout(
      () => {
        if (compacting) setCategories((previous) => [...previous, "checks"]);
        else advance();
      },
      compacting ? 650 + Math.random() * 900 : SCRIPT[index]!.delay
    );
    return () => window.clearTimeout(timer);
  });
  const notes = SCRIPT.slice(0, index + 1).filter((event) => "text" in event);
  return (
    <section className="max-w-2xl space-y-5" aria-label="Simulated agent turn">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Simulated turn</h2>
        <div className="flex flex-wrap gap-2">
          {!done && (
            <Button
              variant="ghost"
              onClick={() => setPlaying((value) => !value)}
            >
              {playing ? "Pause" : "Play"}
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => {
              setIndex(0);
              setCategories(["think"]);
              setTimes([Date.now()]);
              setPlaying(true);
            }}
          >
            Replay
          </Button>
          {compacting && <Button onClick={advance}>Finish compaction</Button>}
        </div>
      </div>
      {compacting && (
        <p className="text-sm text-muted-foreground">
          Let compaction run, then finish it to watch normal work resume.
        </p>
      )}
      <div className="rounded-lg bg-muted/30 p-4 text-sm">
        Review the placeholder change, run checks, and summarize the result.
      </div>
      <div className="space-y-3">
        <div className="text-sm font-medium">Dispatch agent</div>
        {notes.map((event) => (
          <p key={event.label} className="text-sm text-muted-foreground">
            {"text" in event ? event.text : ""}
          </p>
        ))}
        {!done && (
          <DefragPreviewGrid categories={categories} compacting={compacting} />
        )}
        <ActivityBlock
          trace={{
            steps,
            startedAt,
            ...(done
              ? { endedAt: times[SCRIPT.length]!, finalResult: "ok" as const }
              : {}),
          }}
        />
        {done && (
          <p className="text-sm text-status-working" role="status">
            Turn complete · checks passed
          </p>
        )}
      </div>
    </section>
  );
}
