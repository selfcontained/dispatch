import { lazy, Suspense, useEffect, useState } from "react";
import { useAtom } from "jotai";

import { whiteboardAgentDrewAtomFamily } from "@/lib/store";
import { cn } from "@/lib/utils";

const WhiteboardTab = lazy(() => import("@/components/app/whiteboard-tab"));

type WhiteboardPaneProps = {
  agentId: string | null;
  active: boolean;
};

export function WhiteboardPane({
  agentId,
  active,
}: WhiteboardPaneProps): JSX.Element | null {
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (active) setOpened(true);
  }, [active]);

  const [agentDrew, setAgentDrew] = useAtom(
    whiteboardAgentDrewAtomFamily(agentId ?? "")
  );
  useEffect(() => {
    if (active && agentId && agentDrew) setAgentDrew(false);
  }, [active, agentId, agentDrew, setAgentDrew]);

  if (!opened || !agentId) return null;
  return (
    <div className={cn("h-full", !active && "hidden")}>
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading whiteboard…
          </div>
        }
      >
        <WhiteboardTab key={agentId} agentId={agentId} visible={active} />
      </Suspense>
    </div>
  );
}
