import { Navigate, Outlet } from "react-router-dom";
import { useAuthContext } from "@/contexts/auth-context";
import { Button } from "@/components/ui/button";

export function AuthLayout(): JSX.Element {
  const { authState, retryAuth } = useAuthContext();

  if (authState === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
        <span className="text-sm">Connecting to server...</span>
      </div>
    );
  }

  if (authState === "error") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background text-muted-foreground">
        <span className="text-sm">Unable to reach the server.</span>
        <Button variant="ghost" size="sm" onClick={retryAuth}>
          Retry
        </Button>
      </div>
    );
  }

  if (authState === "needs-login") {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
