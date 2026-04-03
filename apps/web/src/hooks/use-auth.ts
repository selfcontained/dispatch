import { useCallback, useEffect, useState } from "react";
import { type AuthState } from "@/components/app/types";
import { authEvents } from "@/lib/api";

export function useAuth(): {
  authState: AuthState;
  handleAuthenticated: () => void;
  handleLogout: () => Promise<void>;
} {
  const [authState, setAuthState] = useState<AuthState>("loading");

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/v1/auth/status", { credentials: "include" });
        if (!res.ok) {
          // Can't determine auth state — let the user through; the backend
          // enforces auth on every API call anyway.
          setAuthState("authenticated");
          return;
        }
        const data = (await res.json()) as { passwordSet: boolean; authenticated: boolean };
        if (data.passwordSet && !data.authenticated) {
          setAuthState("needs-login");
        } else {
          setAuthState("authenticated");
        }
      } catch {
        setAuthState("authenticated");
      }
    })();
  }, []);

  // Listen for 401s from the shared api() utility.
  useEffect(() => {
    const onUnauthenticated = () => setAuthState("needs-login");
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
