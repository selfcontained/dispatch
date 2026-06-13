import { Navigate, Outlet, useParams } from "react-router-dom";

import { AuthContextProvider } from "@/contexts/auth-context-provider";
import { useAuth } from "@/hooks/use-auth";

export function RootLayout(): JSX.Element {
  const auth = useAuth();
  return (
    <AuthContextProvider value={auth}>
      <Outlet />
    </AuthContextProvider>
  );
}

export function LegacyDocsRedirect(): JSX.Element {
  const { section } = useParams();
  return (
    <Navigate
      to={section ? `/settings/help/${section}` : "/settings/help"}
      replace
    />
  );
}

export function LegacyJobsRedirect(): JSX.Element {
  const { "*": rest } = useParams();
  return <Navigate to={`/automations/jobs/${rest ?? ""}`} replace />;
}
