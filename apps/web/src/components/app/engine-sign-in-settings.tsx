import type { EngineAuthStatus } from "@dispatch/shared";

import { EngineSignIn } from "@/components/app/engine-sign-in";
import { ENGINE_LOGIN_LABELS, useEngineAuth } from "@/hooks/use-engine-login";

function EngineRow({ status }: { status: EngineAuthStatus }): JSX.Element {
  const label = ENGINE_LOGIN_LABELS[status.engine];
  const state = !status.installed
    ? "Not installed"
    : status.signedIn
      ? `Signed in${status.detail ? ` · ${status.detail}` : ""}`
      : "Signed out";
  return (
    <div
      className="space-y-3 rounded border border-border px-3 py-3"
      data-testid={`engine-auth-${status.engine}`}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <p className="mt-1 truncate text-xs text-muted-foreground">{state}</p>
      </div>
      {status.installed ? <EngineSignIn engine={status.engine} /> : null}
    </div>
  );
}

/** Whether each engine's CLI is signed in on this server, with a way to sign in. */
export function EngineSignInSettings(): JSX.Element {
  const { data, isPending, error } = useEngineAuth();
  return (
    <section
      aria-label="Engine sign-in"
      className="flex flex-col gap-4 border-t border-border p-6"
    >
      <div className="max-w-lg">
        <h2 className="text-sm font-medium text-foreground">Engine sign-in</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The Claude Code and Codex accounts this Dispatch server's agents run
          as. Signing in here signs in every agent of that engine.
        </p>
      </div>
      <div className="max-w-lg space-y-2">
        {isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Checking sign-in…
          </p>
        ) : error ? (
          <p role="alert" className="text-sm text-destructive">
            {error.message}
          </p>
        ) : (
          data?.engines.map((status) => (
            <EngineRow key={status.engine} status={status} />
          ))
        )}
      </div>
    </section>
  );
}
