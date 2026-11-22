import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type AuthState } from "@/components/app/types";
import { authEvents } from "@/lib/api";

export type AuthStatus = {
  passwordSet: boolean;
  authenticated: boolean;
  exposed: boolean;
};

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch("/api/v1/auth/status", { credentials: "include" });
  if (!res.ok) throw new Error(`auth/status ${res.status}`);
  return (await res.json()) as AuthStatus;
}

export function useAuth(): {
  authState: AuthState;
  exposed: boolean;
  handleAuthenticated: () => void;
  handleLogout: () => Promise<void>;
  retryAuth: () => void;
} {
  const [authState, setAuthState] = useState<AuthState>("loading");
  const passwordSetRef = useRef(false);
  const queryClient = useQueryClient();

  const { data, isError, isPaused, refetch } = useQuery<AuthStatus>({
    queryKey: ["auth-status"],
    queryFn: fetchAuthStatus,
    // The server is usually this machine, which navigator.onLine says
    // nothing about.
    networkMode: "always",
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (data) {
      passwordSetRef.current = data.passwordSet;
      if (data.passwordSet && !data.authenticated) {
        setAuthState("needs-login");
      } else {
        setAuthState("authenticated");
      }
    } else {
      // A retry waits for focus, so a paused query has failed and has nothing
      // in flight. Until there is data, only a login can outrank this.
      setAuthState((current) =>
        current === "authenticated" || current === "needs-login"
          ? current
          : isError || isPaused
            ? "error"
            : "loading"
      );
    }
  }, [data, isError, isPaused]);

  // Listen for 401s from the shared api() utility — only transition to
  // needs-login when we know a password is configured.
  useEffect(() => {
    const onUnauthenticated = () => {
      if (passwordSetRef.current) {
        setAuthState("needs-login");
      }
    };
    authEvents.addEventListener("unauthenticated", onUnauthenticated);
    return () =>
      authEvents.removeEventListener("unauthenticated", onUnauthenticated);
  }, []);

  const handleAuthenticated = useCallback(
    () => setAuthState("authenticated"),
    []
  );

  const handleLogout = useCallback(async () => {
    await fetch("/api/v1/auth/logout", {
      method: "POST",
      credentials: "include",
    });
    setAuthState("needs-login");
    void queryClient.invalidateQueries({ queryKey: ["auth-status"] });
  }, [queryClient]);

  const retryAuth = useCallback(() => {
    // A paused fetch absorbs a refetch, so drop it before asking again.
    void queryClient
      .cancelQueries({ queryKey: ["auth-status"] })
      .then(() => refetch());
  }, [queryClient, refetch]);

  return {
    authState,
    exposed: data?.exposed ?? false,
    handleAuthenticated,
    handleLogout,
    retryAuth,
  };
}
