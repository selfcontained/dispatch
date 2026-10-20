import { lazy, Suspense, useState } from "react";
const TerminalDrawer = lazy(() => import("./terminal-drawer"));

/** Defer the entire terminal bundle and first request until actually visible. */
export function TerminalLauncher({
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
      <TerminalDrawer agentId={agentId} active={active} />
    </Suspense>
  );
}
