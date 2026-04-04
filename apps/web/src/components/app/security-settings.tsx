import { useEffect, useState, type FormEvent } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type SecuritySettingsProps = {
  onLogout: () => void;
};

export function SecuritySettings({ onLogout }: SecuritySettingsProps): JSX.Element {
  const [passwordSet, setPasswordSet] = useState<boolean | null>(null);

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/v1/auth/status", { credentials: "include" });
        if (res.ok) {
          const data = (await res.json()) as { passwordSet: boolean };
          setPasswordSet(data.passwordSet);
        }
      } catch {
        // ignore
      }
    })();
  }, []);

  const resetForm = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setError("");
  };

  const handleSetPassword = async (e: FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8 || newPassword !== confirmPassword) return;
    setError("");
    setMessage("");
    setLoading(true);
    try {
      const res = await fetch("/api/v1/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password: newPassword })
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setError(body.error ?? "Failed to set password.");
        return;
      }
      setMessage("Password set successfully.");
      setPasswordSet(true);
      resetForm();
    } catch {
      setError("Unable to reach the server.");
    } finally {
      setLoading(false);
    }
  };

  const handleChangePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (!currentPassword || newPassword.length < 8 || newPassword !== confirmPassword) return;
    setError("");
    setMessage("");
    setLoading(true);
    try {
      const res = await fetch("/api/v1/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ currentPassword, newPassword })
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setError(body.error ?? "Failed to change password.");
        return;
      }
      setMessage("Password changed successfully.");
      resetForm();
    } catch {
      setError("Unable to reach the server.");
    } finally {
      setLoading(false);
    }
  };

  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;

  if (passwordSet === null) {
    return (
      <div className="p-6 text-sm text-muted-foreground">Loading...</div>
    );
  }

  return (
    <div className="flex flex-col gap-8 p-6">
      <div>
        <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {passwordSet ? "Change Password" : "Set Password"}
        </h3>
        {!passwordSet && (
          <p className="mb-4 text-sm text-muted-foreground">
            No password is set. Anyone who can reach this server has full access. Set a password to require authentication.
          </p>
        )}
        <form onSubmit={passwordSet ? handleChangePassword : handleSetPassword} className="max-w-sm space-y-3">
          {passwordSet && (
            <Input
              type="password"
              placeholder="Current password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              data-testid="change-current-password"
            />
          )}
          <Input
            type="password"
            placeholder={passwordSet ? "New password (min 8 characters)" : "Password (min 8 characters)"}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            data-testid="security-new-password"
          />
          <Input
            type="password"
            placeholder="Confirm password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            data-testid="security-confirm-password"
          />
          {mismatch && <p className="text-sm text-destructive">Passwords do not match.</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {message && <p className="text-sm text-status-working">{message}</p>}
          <Button
            type="submit"
            variant="primary"
            disabled={loading || newPassword.length < 8 || newPassword !== confirmPassword || (passwordSet && !currentPassword)}
          >
            {loading ? (passwordSet ? "Changing..." : "Setting up...") : (passwordSet ? "Change password" : "Set password")}
          </Button>
        </form>
      </div>

      {passwordSet && (
        <div>
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Session
          </h3>
          <Button variant="destructive" onClick={onLogout} data-testid="logout-button">
            Log out
          </Button>
        </div>
      )}
    </div>
  );
}
