import { Navigate, Outlet } from "react-router-dom";
import { useAuthContext } from "@/contexts/auth-context";

export function AuthLayout(): JSX.Element {
  const { authState } = useAuthContext();

  if (authState === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
        <span className="text-sm">Loading...</span>
      </div>
    );
  }

  if (authState === "needs-login") {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
