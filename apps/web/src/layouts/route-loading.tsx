import { LoaderCircle } from "lucide-react";
import { useNavigation } from "react-router-dom";

import { Button } from "@/components/ui/button";

export function RouteLoading(): JSX.Element {
  return (
    <div
      className="flex min-h-screen items-center justify-center gap-2 bg-background text-muted-foreground"
      role="status"
    >
      <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
      Loading section…
    </div>
  );
}

export function RoutePendingIndicator(): JSX.Element | null {
  const navigation = useNavigation();
  if (navigation.state === "idle") return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-3 z-[100] flex justify-center"
      role="status"
    >
      <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm text-muted-foreground shadow-md">
        <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading section…
      </div>
    </div>
  );
}

export function RouteLoadError(): JSX.Element {
  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-foreground"
      role="alert"
    >
      <p>This section couldn’t be loaded.</p>
      <p className="text-center text-sm text-muted-foreground">
        Check your connection, then reload to try again.
      </p>
      <Button onClick={() => window.location.reload()}>Reload page</Button>
    </div>
  );
}
