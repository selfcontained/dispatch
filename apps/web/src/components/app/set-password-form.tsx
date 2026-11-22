import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Field } from "@/components/ui/field";
import {
  DialogBody,
  DialogCancel,
  DialogFooter,
  DialogForm,
} from "@/components/ui/dialog";

export function SetPasswordForm({
  onSuccess,
  onPasswordAlreadySet,
  inDialog = false,
}: {
  /** Lays it out as the dialog's body and footer. */
  inDialog?: boolean;
  onSuccess?: () => void;
  onPasswordAlreadySet?: () => void;
}) {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(false);
  const mismatch = confirm.length > 0 && password !== confirm;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (loading || password.length < 8 || password !== confirm) return;
    setError(undefined);
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
        if (
          response.status === 400 &&
          body.error === "Password is already set." &&
          onPasswordAlreadySet
        ) {
          onPasswordAlreadySet();
          await queryClient.invalidateQueries({ queryKey: ["auth-status"] });
          return;
        }
        setError(new Error(body.error ?? "The server rejected the password."));
        return;
      }
      setPassword("");
      setConfirm("");
      onSuccess?.();
      await queryClient.invalidateQueries({ queryKey: ["auth-status"] });
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  const tooShort = password.length > 0 && password.length < 8;
  const fields = (
    <>
      <Field
        label="Password"
        hint={tooShort ? null : "At least 8 characters."}
        error={tooShort ? "Use at least 8 characters." : null}
      >
        <Input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
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
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          data-testid="security-confirm-password"
        />
      </Field>
    </>
  );
  const failure = error ? (
    <Alert title="Couldn’t set the password." error={error} />
  ) : null;
  const button = (
    <Button
      type="submit"
      variant="primary"
      pending={loading}
      disabled={password.length < 8 || password !== confirm}
    >
      Set password
    </Button>
  );

  return inDialog ? (
    <DialogForm onSubmit={submit}>
      <DialogBody className="space-y-3">{fields}</DialogBody>
      {failure}
      <DialogFooter>
        <DialogCancel />
        {button}
      </DialogFooter>
    </DialogForm>
  ) : (
    <form onSubmit={submit} className="w-full max-w-sm space-y-3">
      {fields}
      {failure}
      {button}
    </form>
  );
}
