import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { SetPasswordForm } from "./set-password-form";
import { CertificateTrustSettings } from "./certificate-trust-settings";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { LoadError } from "@/components/ui/async-boundary";
import { SettingsGroup } from "@/components/app/settings-layout";
import { Panel } from "@/components/ui/card";
import { SettingRow } from "@/components/ui/setting-row";
import { Field } from "@/components/ui/field";
import { LoadingSkeleton } from "@/components/ui/skeleton";

type SecuritySettingsProps = {
  onLogout: () => void | Promise<void>;
};

export function SecuritySettings({
  onLogout,
}: SecuritySettingsProps): JSX.Element {
  const [passwordSet, setPasswordSet] = useState<boolean | null>(null);

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [message, setMessage] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [logoutError, setLogoutError] = useState<unknown>();
  const [failure, setFailure] = useState<unknown>();
  const [statusError, setStatusError] = useState<unknown>();
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/v1/auth/status", {
          credentials: "include",
        });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
        const data = (await res.json()) as { passwordSet: boolean };
        setPasswordSet(data.passwordSet);
        setStatusError(undefined);
      } catch (err) {
        setStatusError(err);
      }
    })();
  }, [attempt]);

  const resetForm = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setFieldError("");
    setFailure(undefined);
  };

  const handleChangePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (
      !currentPassword ||
      newPassword.length < 8 ||
      newPassword !== confirmPassword
    )
      return;
    setFieldError("");
    setFailure(undefined);
    setMessage("");
    setLoading(true);
    try {
      const res = await fetch("/api/v1/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        const reason = body.error ?? "The server rejected the change.";
        // Only a wrong current password comes back as 401.
        if (res.status === 401) setFieldError(reason);
        else setFailure(new Error(reason));
        return;
      }
      setMessage("Password changed successfully.");
      resetForm();
    } catch (err) {
      setFailure(err);
    } finally {
      setLoading(false);
    }
  };

  const mismatch =
    confirmPassword.length > 0 && newPassword !== confirmPassword;

  if (passwordSet === null) {
    return (
      <div>
        {statusError ? (
          <LoadError
            thing="security settings"
            error={statusError}
            onRetry={() => setAttempt((count) => count + 1)}
          />
        ) : (
          <LoadingSkeleton label="Loading security settings…" />
        )}
      </div>
    );
  }

  return (
    <>
      <CertificateTrustSettings />
      <SettingsGroup
        title={passwordSet ? "Change password" : "Set password"}
        description={
          passwordSet
            ? undefined
            : "No password is set. Anyone who can reach this server has full access. Set a password to require authentication."
        }
      >
        <Panel>
          {!passwordSet ? (
            <SetPasswordForm
              onSuccess={() => {
                setPasswordSet(true);
                setMessage("Password set successfully.");
              }}
            />
          ) : (
            <form
              onSubmit={handleChangePassword}
              className="max-w-sm space-y-3"
            >
              <Field label="Current password" error={fieldError}>
                <Input
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(e) => {
                    setCurrentPassword(e.target.value);
                    setFieldError("");
                  }}
                  data-testid="change-current-password"
                />
              </Field>
              <Field
                label="New password"
                hint="At least 8 characters."
                error={
                  newPassword && newPassword.length < 8
                    ? "Use at least 8 characters."
                    : null
                }
              >
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  data-testid="security-new-password"
                />
              </Field>
              <Field
                label="Confirm password"
                error={mismatch ? "Passwords do not match." : null}
              >
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  data-testid="security-confirm-password"
                />
              </Field>
              {failure ? (
                <Alert title="Couldn’t change the password." error={failure} />
              ) : null}
              {message && (
                <p role="status" className="text-body-md text-success-ink">
                  {message}
                </p>
              )}
              <Button
                type="submit"
                variant="primary"
                pending={loading}
                disabled={
                  newPassword.length < 8 ||
                  newPassword !== confirmPassword ||
                  !currentPassword
                }
              >
                Change password
              </Button>
            </form>
          )}
        </Panel>
      </SettingsGroup>

      {passwordSet && (
        <SettingsGroup title="Session">
          <SettingRow
            layout="action"
            label="Log out"
            description="You’ll need the password to get back in."
          >
            <Button
              variant="danger"
              onClick={async () => {
                setLogoutError(undefined);
                try {
                  await onLogout();
                } catch (error) {
                  setLogoutError(error);
                }
              }}
              data-testid="logout-button"
            >
              Log out
            </Button>
          </SettingRow>
          {logoutError ? (
            <Alert
              title="Couldn’t log out."
              error={logoutError}
              className="mt-2"
            />
          ) : null}
        </SettingsGroup>
      )}
    </>
  );
}
