import { useId, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function SetPasswordForm({ onSuccess }: { onSuccess?: () => void }) {
  const id = useId();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const mismatch = confirm.length > 0 && password !== confirm;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (loading || password.length < 8 || password !== confirm) return;
    setError("");
    setLoading(true);
    try {
      const response = await fetch("/api/v1/auth/setup", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        setError(body.error ?? "Failed to set password.");
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["auth-status"] });
      setPassword("");
      setConfirm("");
      onSuccess?.();
    } catch {
      setError("Unable to reach the server.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full max-w-sm space-y-3">
      <div className="space-y-1">
        <label htmlFor={`${id}-password`} className="text-sm">
          Password
        </label>
        <Input
          id={`${id}-password`}
          type="password"
          autoComplete="new-password"
          placeholder="Password (min 8 characters)"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          data-testid="security-new-password"
        />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-confirm`} className="text-sm">
          Confirm password
        </label>
        <Input
          id={`${id}-confirm`}
          type="password"
          autoComplete="new-password"
          placeholder="Confirm password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          data-testid="security-confirm-password"
        />
      </div>
      {mismatch && (
        <p className="text-sm text-destructive">Passwords do not match.</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button
        type="submit"
        variant="primary"
        disabled={loading || password.length < 8 || password !== confirm}
      >
        {loading ? "Setting up..." : "Set password"}
      </Button>
    </form>
  );
}
