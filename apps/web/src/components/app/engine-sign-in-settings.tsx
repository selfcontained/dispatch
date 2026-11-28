import type { EngineScope } from "@dispatch/runner-protocol/engine-management";
import { LOCAL_ENGINE_SCOPE } from "@/lib/engine-management";
import type { EngineAuthStatus } from "@dispatch/shared";

import { EngineSignIn } from "@/components/app/engine-sign-in";
import { ENGINE_LOGIN_LABELS, useEngineAuth } from "@/hooks/use-engine-login";
import { SettingsGroup } from "@/components/app/settings-layout";
import { SettingRow } from "@/components/ui/setting-row";
import { AsyncBoundary } from "@/components/ui/async-boundary";

function EngineRow({
  status,
  scope,
}: {
  status: EngineAuthStatus;
  scope: EngineScope;
}): JSX.Element {
  const label = ENGINE_LOGIN_LABELS[status.engine];
  const state = !status.installed
    ? "Not installed"
    : status.signedIn
      ? `Signed in${status.detail ? ` · ${status.detail}` : ""}`
      : "Signed out";
  return (
    <SettingRow
      layout="group"
      label={label}
      description={state}
      data-testid={`engine-auth-${status.engine}`}
    >
      {status.installed ? (
        <EngineSignIn engine={status.engine} scope={scope} />
      ) : null}
    </SettingRow>
  );
}

/** Whether each engine's CLI is signed in on this server, with a way to sign in. */
export function EngineSignInSettings({
  scope = LOCAL_ENGINE_SCOPE,
}: { scope?: EngineScope } = {}): JSX.Element {
  const query = useEngineAuth(scope);
  return (
    <SettingsGroup
      aria-label="Engine sign-in"
      title="Engine sign-in"
      description="The Claude Code and Codex accounts this Dispatch server’s agents run as. Signing in here signs in every agent of that engine."
    >
      <AsyncBoundary query={query} thing="sign-in status">
        {({ engines }) =>
          engines.map((status) => (
            <EngineRow key={status.engine} status={status} scope={scope} />
          ))
        }
      </AsyncBoundary>
    </SettingsGroup>
  );
}
