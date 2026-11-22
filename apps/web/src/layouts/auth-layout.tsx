import { Navigate, Outlet } from "react-router-dom";
import { useAuthContext } from "@/contexts/auth-context";
import { LoadError } from "@/components/app/load-error";
import { Button } from "@/components/ui/button";
import { clearCachesAndReload } from "@/lib/pwa-update";

function ClearReloadButton() {
  return (
    <div className="fixed bottom-4 right-4">
      <Button
        variant="default"
        size="sm"
        onClick={() => void clearCachesAndReload()}
      >
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
        <span className="text-sm">Connecting to server...</span>
        <ClearReloadButton />
      </div>
    );
  }

  if (authState === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4 text-muted-foreground">
        <LoadError
          message="Couldn't connect to the server."
          onRetry={retryAuth}
          className="w-full max-w-sm"
        />
        <ClearReloadButton />
      </div>
    );
  }

  if (authState === "needs-login") {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
