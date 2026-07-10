import { lazy, Suspense, useEffect } from "react";
import { useSetAtom } from "jotai";

import { whiteboardAgentDrewAtomFamily } from "@/lib/store";
import type { ThemeId } from "@/hooks/use-theme";

const WhiteboardTab = lazy(() =>
  import("@/components/app/whiteboard-tab").then((m) => ({
    default: m.WhiteboardTab,
  }))
);

type WhiteboardPaneProps = {
  agentId: string | null;
  active: boolean;
  theme: ThemeId;
};

export function WhiteboardPane({
  agentId,
  active,
  theme,
}: WhiteboardPaneProps) {
  const setAgentDrew = useSetAtom(whiteboardAgentDrewAtomFamily(agentId ?? ""));

  useEffect(() => {
    if (active && agentId) {
      setAgentDrew(false);
    }
  }, [active, agentId, setAgentDrew]);

  if (!agentId) return null;

  return (
    <div className={active ? "h-full" : "hidden"} data-testid="whiteboard-pane">
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center text-muted-foreground">
            Loading whiteboard…
          </div>
        }
      >
        <WhiteboardTab agentId={agentId} theme={theme} />
      </Suspense>
    </div>
  );
}
