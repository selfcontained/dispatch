import { useEffect, useState } from "react";
import { Navigate, Outlet, useParams } from "react-router-dom";

import { StartupOutage } from "@/components/app/startup-outage";
import { AuthContextProvider } from "@/contexts/auth-context-provider";
import { useAuth } from "@/hooks/use-auth";
import { useHealth } from "@/hooks/use-health";
import { availabilityEvents } from "@/lib/api";

export function RootLayout(): JSX.Element {
  const auth = useAuth();
  const { startupState, startupError } = useHealth(true);
  const [requestError, setRequestError] = useState<string | null>(null);

  useEffect(() => {
    const onDatabaseUnavailable = (event: Event) => {
      setRequestError(
        (event as CustomEvent<{ message?: string }>).detail?.message ??
          "Dispatch is waiting for its database."
      );
    };
    availabilityEvents.addEventListener(
      "database-unavailable",
      onDatabaseUnavailable
    );
    return () =>
      availabilityEvents.removeEventListener(
        "database-unavailable",
        onDatabaseUnavailable
      );
  }, []);

  useEffect(() => {
    if (startupState === "ready") setRequestError(null);
  }, [startupState]);

  if (requestError || startupState !== "ready") {
    return <StartupOutage error={requestError ?? startupError} />;
  }

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
