import { useCallback, useEffect, useRef, useState } from "react";
import { type AuthState } from "@/components/app/types";
import { authEvents } from "@/lib/api";

export function useAuth(): {
  authState: AuthState;
  handleAuthenticated: () => void;
  handleLogout: () => Promise<void>;
} {
  const [authState, setAuthState] = useState<AuthState>("loading");
  const passwordSetRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function checkAuth() {
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch("/api/v1/auth/status", { credentials: "include" });
          if (!res.ok) {
            // Server error — retry after a delay since we can't determine auth state.
            await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 5000)));
            continue;
          }
          const data = (await res.json()) as { passwordSet: boolean; authenticated: boolean };
          if (cancelled) return;
          passwordSetRef.current = data.passwordSet;
          if (data.passwordSet && !data.authenticated) {
            setAuthState("needs-login");
          } else {
            setAuthState("authenticated");
          }
          return;
        } catch {
          // Network error (server not reachable) — retry.
          await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 5000)));
        }
      }
    }

    void checkAuth();
    return () => { cancelled = true; };
  }, []);

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
