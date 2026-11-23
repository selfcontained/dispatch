import { useNavigation } from "react-router-dom";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";

export function RouteLoading(): JSX.Element {
  return (
    <div
      className="flex min-h-screen items-center justify-center gap-2 bg-background text-muted-foreground"
      role="status"
    >
      <Spinner className="size-icon-lg" />
      Loading section…
    </div>
  );
}

export function RoutePendingIndicator(): JSX.Element | null {
  const navigation = useNavigation();
  if (navigation.state === "idle") return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-3 z-progress flex justify-center"
      role="status"
    >
      <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-body-md text-muted-foreground shadow-md">
        <Spinner className="size-icon-lg" />
        Loading section…
      </div>
    </div>
  );
}

export function RouteLoadError(): JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <Alert
        title="Couldn’t load the section."
        className="w-full max-w-sm"
        action={{
          label: "Reload page",
          onClick: () => window.location.reload(),
        }}
      >
        Check your connection, then reload to try again.
      </Alert>
    </div>
  );
}
