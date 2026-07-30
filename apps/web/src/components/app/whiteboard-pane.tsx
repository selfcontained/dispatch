import { Component, lazy, Suspense, useEffect, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { useAtom } from "jotai";

import { whiteboardAgentDrewAtomFamily } from "@/lib/store";
import { cn } from "@/lib/utils";

const WhiteboardTab = lazy(() => import("@/components/app/whiteboard-tab"));

// A scene the editor can't restore must not escape to the router's error
// boundary, which would blank the entire app instead of just this tab.
class WhiteboardErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Whiteboard failed to render", error, info);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
          This whiteboard could not be rendered. Reload to try again — if it
          keeps failing, ask the agent to clear the board.
        </div>
      );
    }
    return this.props.children;
  }
}

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
      <WhiteboardErrorBoundary key={agentId}>
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Loading whiteboard…
            </div>
          }
        >
          <WhiteboardTab agentId={agentId} visible={active} />
        </Suspense>
      </WhiteboardErrorBoundary>
    </div>
  );
}
