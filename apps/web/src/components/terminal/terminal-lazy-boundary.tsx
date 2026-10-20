import { lazy, Suspense, useState } from "react";
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
        <p role="status" className="p-3 text-xs">
          Loading terminal…
        </p>
      }
    >
      <TerminalPanel agentId={agentId} active={active} />
    </Suspense>
  );
}
