import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { type AuthState } from "@/components/app/types";
import { authEvents } from "@/lib/api";

type AuthStatus = { passwordSet: boolean; authenticated: boolean };

async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch("/api/v1/auth/status", { credentials: "include" });
  if (!res.ok) throw new Error(`auth/status ${res.status}`);
  return (await res.json()) as AuthStatus;
}

export function useAuth(): {
  authState: AuthState;
  handleAuthenticated: () => void;
  handleLogout: () => Promise<void>;
} {
  const [authState, setAuthState] = useState<AuthState>("loading");
  const passwordSetRef = useRef(false);

  const { data } = useQuery<AuthStatus>({
    queryKey: ["auth-status"],
    queryFn: fetchAuthStatus,
    retry: true,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!data) return;
    passwordSetRef.current = data.passwordSet;
    if (data.passwordSet && !data.authenticated) {
      setAuthState("needs-login");
    } else {
      setAuthState("authenticated");
    }
  }, [data]);

  // Listen for 401s from the shared api() utility — only transition to
  // needs-login when we know a password is configured.
  useEffect(() => {
    const onUnauthenticated = () => {
      if (passwordSetRef.current) {
        setAuthState("needs-login");
      }
    };
    authEvents.addEventListener("unauthenticated", onUnauthenticated);
    return () => authEvents.removeEventListener("unauthenticated", onUnauthenticated);
  }, []);

  const handleAuthenticated = useCallback(() => setAuthState("authenticated"), []);

  const handleLogout = useCallback(async () => {
    await fetch("/api/v1/auth/logout", { method: "POST", credentials: "include" });
    setAuthState("needs-login");
  }, []);

  return { authState, handleAuthenticated, handleLogout };
}
