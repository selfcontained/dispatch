import { lazy, Suspense, useState } from "react";
import { LoadingSkeleton } from "@/components/ui/skeleton";
const TerminalPanel = lazy(() => import("./terminal-panel"));

/** Defer the entire terminal bundle and first request until actually visible. */
export function TerminalLazyBoundary({
  agentId,
  active,
}: {
  agentId: string;
  active: boolean;
}) {
  const [loaded, setLoaded] = useState(active);
  if (active && !loaded) setLoaded(true);
  if (!loaded) return null;
  return (
    <Suspense
      fallback={
        <LoadingSkeleton label="Loading terminal…" className="w-auto p-3" />
      }
    >
      <TerminalPanel agentId={agentId} active={active} />
    </Suspense>
  );
}
