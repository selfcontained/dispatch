import { RunnerPlugin } from "./runner-plugin";
import { useEffect, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";

import type {
  EngineInventoryEntry,
  EngineLoginView,
} from "@dispatch/runner-protocol/engine-management";

import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Input } from "@/components/ui/input";
import {
  useRunnerEngineInventory,
  useRunnerEngineLoginStatus,
  useRunnerEngineOperation,
} from "@/hooks/use-runner-engines";
import type { EngineScope } from "@dispatch/runner-protocol/engine-management";

/**
 * Engine install/update/sign-in for one scope: this machine, or a named
 * runner workspace. Self-contained — the caller only supplies `scope`
 * (and, for a runner, the surrounding "which runner/workspace" picker).
 * See `use-runner-engines.ts` for the HTTP contract this expects.
 */
export function RunnerEngines({
  scope,
  capabilities = false,
}: {
  scope: EngineScope;
  capabilities?: boolean;
}): JSX.Element {
  const inventory = useRunnerEngineInventory(scope);
  const entries = inventory.data?.entries ?? [];
  const [activeLogin, setActiveLogin] = useState<EngineLoginView | null>(null);

  if (inventory.isLoading) {
    return (
      <p
        role="status"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Loading engines…
      </p>
    );
  }

  if (inventory.isError) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p role="alert" className="text-sm text-destructive">
          Could not load engines.
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void inventory.refetch()}
        >
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div
      className="divide-y divide-border rounded-md border border-border px-3"
      data-testid="runner-engines"
    >
      {entries.length === 0 && (
        <p className="py-3 text-sm text-muted-foreground">
          No engines reported.
        </p>
      )}
      {entries.map((entry) => (
        <EngineRow
          key={entry.id}
          scope={scope}
          entry={entry}
          capabilities={capabilities}
          activeLogin={activeLogin?.engine === entry.id ? activeLogin : null}
          onLoginChange={(login) =>
            setActiveLogin(login && login.engine === entry.id ? login : null)
          }
        />
      ))}
    </div>
  );
}

function isLoginActive(login: EngineLoginView | null): boolean {
  return (
    login?.status === "starting" ||
    login?.status === "waiting" ||
    login?.status === "verifying"
  );
}

function EngineRow({
  scope,
  entry,
  capabilities,
  activeLogin,
  onLoginChange,
}: {
  scope: EngineScope;
  entry: EngineInventoryEntry;
  capabilities: boolean;
  activeLogin: EngineLoginView | null;
  onLoginChange: (login: EngineLoginView | null) => void;
}): JSX.Element {
  const operation = useRunnerEngineOperation(scope);
  const [code, setCode] = useState("");
  const [actionResult, setActionResult] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);

  // The CLI's own output (a code being verified, a device flow finishing
  // on its own) settles asynchronously, after login_start/login_submit
  // already returned — poll the sign-in's current view while it's active
  // so that settling is actually visible instead of stuck on "waiting".
  const loginActive = isLoginActive(activeLogin);
  const loginStatus = useRunnerEngineLoginStatus(
    scope,
    loginActive ? activeLogin!.id : null
  );
  useEffect(() => {
    const polled = loginStatus.data?.ack;
    if (polled?.ok && polled.login) onLoginChange(polled.login);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loginStatus.data]);

  const run = (
    op: Parameters<ReturnType<typeof useRunnerEngineOperation>["mutate"]>[0]
  ) => {
    setActionResult(null);
    operation.mutate(op, {
      onSuccess: ({ ack }) => {
        if (ack.ok && ack.login) onLoginChange(ack.login);
        if (op.type === "install" || op.type === "update") {
          setActionResult(
            ack.ok
              ? { kind: "success", message: ack.message ?? "Done." }
              : { kind: "error", message: ack.error }
          );
        }
      },
    });
  };

  const canInstall = entry.actions.includes("install");
  const canUpdate = entry.actions.includes("update");
  const canLogin = entry.actions.includes("login");

  return (
    <div
      className="min-w-0 space-y-2 py-3"
      data-testid={`runner-engine-${entry.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true">
            <AgentTypeIcon
              type={entry.id}
              className="size-9 rounded-lg [&_svg]:size-5"
            />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-medium">{entry.label}</div>
            <p className="mt-0.5 break-words text-xs text-muted-foreground">
              {entry.installed ? (
                <>
                  {entry.version ? `v${entry.version}` : "Installed"}
                  {entry.signedIn === true && " · signed in"}
                  {entry.signedIn === false && " · signed out"}
                  {entry.detail && entry.signedIn && ` · ${entry.detail}`}
                </>
              ) : entry.issue === "install-unavailable" ? (
                (entry.detail ?? "Install unavailable")
              ) : (
                "Not installed"
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canInstall && (
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs"
              disabled={operation.isPending}
              onClick={() => run({ type: "install", engine: entry.id })}
              data-testid={`runner-engine-${entry.id}-install`}
            >
              Install
            </Button>
          )}
          {canUpdate && (
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs"
              disabled={operation.isPending}
              onClick={() => run({ type: "update", engine: entry.id })}
              data-testid={`runner-engine-${entry.id}-update`}
            >
              Update
            </Button>
          )}
          {canLogin &&
            entry.signedIn !== true &&
            !isLoginActive(activeLogin) && (
              <Button
                type="button"
                size="sm"
                className="h-7 text-xs"
                disabled={operation.isPending}
                onClick={() => run({ type: "login_start", engine: entry.id })}
                data-testid={`runner-engine-${entry.id}-sign-in`}
              >
                Sign in
              </Button>
            )}
        </div>
      </div>

      {capabilities &&
        scope.kind === "runner" &&
        entry.installed &&
        entry.id !== "opencode" && (
          <RunnerPlugin runnerId={scope.runnerId} engine={entry.id} />
        )}

      {operation.isError && (
        <p role="alert" className="text-[12px] text-destructive">
          {operation.error.message}
        </p>
      )}

      {actionResult?.kind === "error" && (
        <p
          role="alert"
          className="text-[12px] text-destructive"
          data-testid={`runner-engine-${entry.id}-action-error`}
        >
          {actionResult.message}
        </p>
      )}
      {actionResult?.kind === "success" && (
        <p
          className="flex items-center gap-2 text-[12px] text-foreground"
          data-testid={`runner-engine-${entry.id}-action-success`}
        >
          <CheckCircle2
            className="h-3.5 w-3.5 text-status-working"
            aria-hidden="true"
          />
          {actionResult.message}
        </p>
      )}

      {isLoginActive(activeLogin) && activeLogin && (
        <LoginFlow
          login={activeLogin}
          code={code}
          onCodeChange={setCode}
          onSubmit={() =>
            run({
              type: "login_submit",
              loginId: activeLogin.id,
              code,
            })
          }
          onCancel={() => {
            run({ type: "login_cancel", loginId: activeLogin.id });
            onLoginChange(null);
          }}
          submitting={operation.isPending}
        />
      )}

      {activeLogin?.status === "succeeded" && (
        <p className="flex items-center gap-2 text-[12px] text-foreground">
          <CheckCircle2
            className="h-3.5 w-3.5 text-status-working"
            aria-hidden="true"
          />
          Signed in{activeLogin.detail ? ` (${activeLogin.detail})` : ""}.
        </p>
      )}
      {activeLogin?.status === "failed" && (
        <p role="alert" className="text-[12px] text-destructive">
          {activeLogin.error ?? "The sign-in failed."}
        </p>
      )}
    </div>
  );
}

function LoginFlow({
  login,
  code,
  onCodeChange,
  onSubmit,
  onCancel,
  submitting,
}: {
  login: EngineLoginView;
  code: string;
  onCodeChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitting: boolean;
}): JSX.Element {
  if (login.status !== "waiting" || !login.url) {
    return (
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          {login.status === "verifying"
            ? "Checking the code…"
            : "Starting the sign-in…"}
        </p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex min-w-0 items-start gap-1 rounded border border-border bg-background/60 p-2">
        <code className="min-w-0 flex-1 select-all break-all px-1 font-mono text-[11px] leading-relaxed text-foreground">
          {login.url}
        </code>
        <CopyButton text={login.url} label="Copy" className="shrink-0" />
      </div>
      {login.userCode ? (
        <div className="space-y-1.5">
          <div className="flex min-w-0 items-start gap-1 rounded border border-border bg-background/60 p-2">
            <code className="min-w-0 flex-1 select-all break-all px-1 font-mono text-lg tracking-widest text-foreground">
              {login.userCode}
            </code>
            <CopyButton
              text={login.userCode}
              label="Copy"
              className="shrink-0"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              Waiting for you to finish in the browser…
            </p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={onCancel}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (code.trim()) onSubmit();
          }}
        >
          <Input
            value={code}
            onChange={(event) => onCodeChange(event.target.value)}
            placeholder="Paste code"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label="Sign-in code"
            className="h-8 text-xs"
          />
          <Button
            type="submit"
            size="sm"
            className="h-8 shrink-0 text-xs"
            disabled={!code.trim() || submitting}
          >
            Sign in
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 shrink-0 text-xs"
            onClick={onCancel}
          >
            Cancel
          </Button>
        </form>
      )}
    </div>
  );
}
