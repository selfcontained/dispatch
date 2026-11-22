import { useEffect, useRef, useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import {
  Card,
  CardHeader,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useAuthContext } from "@/contexts/auth-context";
import { Field } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";

type LoginPageProps = {
  onAuthenticated: () => void;
};

export function LoginPage({ onAuthenticated }: LoginPageProps): JSX.Element {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const hasExchangedLoginLink = useRef(false);

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get(
      "login-link"
    );
    if (!token || hasExchangedLoginLink.current) return;

    hasExchangedLoginLink.current = true;
    // URL fragments are not sent to the server, but remove this bearer token
    // from the address bar and browser history before making the exchange.
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}`
    );

    setLoading(true);
    void (async () => {
      try {
        const res = await fetch("/api/v1/auth/login-links/exchange", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ token }),
        });
        if (!res.ok) {
          setError("This login link is invalid or has expired.");
          setLoading(false);
          return;
        }
        setLoading(false);
        onAuthenticated();
      } catch {
        setError(
          "Couldn’t reach the server. Check your connection, then try again."
        );
        setLoading(false);
      }
    })();
  }, [onAuthenticated]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setError(body.error ?? "Login failed.");
        return;
      }
      onAuthenticated();
    } catch {
      setError(
        "Couldn’t reach the server. Check your connection, then try again."
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <h1 className="text-heading-md">Dispatch</h1>
          <CardDescription>Enter your password to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <Field label="Password" error={error}>
              <Input
                type="password"
                autoComplete="current-password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                data-testid="login-password"
              />
            </Field>
            <Button
              type="submit"
              variant="primary"
              className="w-full"
              pending={loading}
              disabled={!password}
            >
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

/** Route wrapper for LoginPage — redirects to / if already authenticated. */
export function LoginRoute(): JSX.Element {
  const { authState, handleAuthenticated } = useAuthContext();
  const navigate = useNavigate();

  if (authState === "authenticated") {
    return <Navigate to="/" replace />;
  }

  if (authState === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
        <Spinner label="Loading" className="size-icon-lg" />
      </div>
    );
  }

  return (
    <LoginPage
      onAuthenticated={() => {
        handleAuthenticated();
        navigate("/", { replace: true });
      }}
    />
  );
}
