import { Navigate, Outlet } from "react-router-dom";
import { useAuthContext } from "@/contexts/auth-context";
import { Button } from "@/components/ui/button";
import { clearCachesAndReload } from "@/lib/pwa-update";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";

function ClearReloadButton() {
  return (
    <div className="fixed bottom-4 right-4">
      <Button size="sm" onClick={() => void clearCachesAndReload()}>
        Clear cache & reload
      </Button>
    </div>
  );
}

export function AuthLayout(): JSX.Element {
  const { authState, retryAuth } = useAuthContext();

  if (authState === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
        <div role="status" className="flex items-center gap-2 text-body-md">
          <Spinner />
          Connecting to server…
        </div>
        <ClearReloadButton />
      </div>
    );
  }

  if (authState === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4 text-muted-foreground">
        <Alert
          title="Couldn’t connect to the server."
          action={{ label: "Retry", onClick: retryAuth }}
          className="w-full max-w-sm"
        >
          Check your connection, then try again.
        </Alert>
        <ClearReloadButton />
      </div>
    );
  }

  if (authState === "needs-login") {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
