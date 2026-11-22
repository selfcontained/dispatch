import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ActivityBlock } from "./chat/turn/activity-block";
import { ResponsePlaceholder } from "./chat/turn/response-placeholder";
import type { Step } from "./chat/turn/contracts";

/** Focused served harness for real placeholder/activity synchronization. */
export function DefragActivityCheckpoint() {
  const [steps, setSteps] = useState<Step[]>([
    {
      id: "outer",
      kind: "execute",
      label: "functions.exec",
      status: "running",
      startedAt: Date.now(),
    },
  ]);
  const [count, setCount] = useState(0);
  return (
    <section className="max-w-xl space-y-4">
      <h1 className="text-heading-lg">Defrag activity</h1>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => {
            const id = count + 1;
            setCount(id);
            setSteps((previous) => [
              {
                ...previous[0]!,
                children: [
                  ...(previous[0]!.children ?? []),
                  {
                    id: `command-${id}`,
                    kind: "execute",
                    label: `command ${id}`,
                    status: "running",
                    startedAt: Date.now(),
                    detail: { input: { command: "git status" } },
                  },
                ],
              },
            ]);
          }}
        >
          Add nested command
        </Button>
        <Button
          onClick={() =>
            setSteps((previous) =>
              previous.map((step) => ({
                ...step,
                status: "ok",
                children: step.children?.map((child) => ({
                  ...child,
                  status: "ok",
                })),
              }))
            )
          }
        >
          Complete commands
        </Button>
      </div>
      <ResponsePlaceholder seed="activity-checkpoint" steps={steps} />
      <ActivityBlock trace={{ steps, startedAt: steps[0]!.startedAt }} />
    </section>
  );
}
