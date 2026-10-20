import { lazy, Suspense, useState } from "react";
import { TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";

const TerminalDrawer = lazy(() => import("./terminal-drawer"));
export function TerminalLauncher({ agentId }: { agentId: string }) {
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="icon"
        variant="ghost"
        title="Terminal"
        aria-label="Open terminal"
        onClick={() => {
          setLoaded(true);
          setOpen(true);
        }}
      >
        <TerminalSquare className="h-4 w-4" />
      </Button>
      {loaded && (
        <Suspense
          fallback={
            open ? (
              <span role="status" className="text-xs">
                Loading terminal…
              </span>
            ) : null
          }
        >
          <TerminalDrawer
            agentId={agentId}
            open={open}
            onOpenChange={setOpen}
          />
        </Suspense>
      )}
    </>
  );
}
