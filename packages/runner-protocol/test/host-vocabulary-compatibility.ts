/** Exact compatibility bytes retained by the host move; never a path or token pattern. */
export const hostVocabularyCompatibility = {
  "upstream Agent Client Protocol terms": [
    {
      file: "packages/runner/src/host/background-ingress.ts",
      token: "asyncTaskId",
      reason:
        "Pinned upstream ACP asynchronous-work field, capability, event or notification name.",
    },
    {
      file: "packages/runner/src/host/background-ingress.ts",
      token: "asyncTasks",
      reason:
        "Pinned upstream ACP asynchronous-work field, capability, event or notification name.",
    },
    {
      file: "packages/runner/src/host/background-ingress.ts",
      token: "async_task_progress",
      reason:
        "Pinned upstream ACP asynchronous-work field, capability, event or notification name.",
    },
    {
      file: "packages/runner/src/host/background-ingress.ts",
      token: "async_task_spawned",
      reason:
        "Pinned upstream ACP asynchronous-work field, capability, event or notification name.",
    },
    {
      file: "packages/runner/src/host/background-ingress.ts",
      token: "async_task_state_update",
      reason:
        "Pinned upstream ACP asynchronous-work field, capability, event or notification name.",
    },
    {
      file: "packages/runner/src/host/background-ingress.ts",
      token: "taskType",
      reason:
        "Pinned upstream ACP asynchronous-work field, capability, event or notification name.",
    },
    {
      file: "packages/runner/src/host/background-work.ts",
      token: "asyncTaskId",
      reason:
        "Pinned upstream ACP asynchronous-work field, capability, event or notification name.",
    },
    {
      file: "packages/runner/src/host/background-work.ts",
      token: "async_task_spawned",
      reason:
        "Pinned upstream ACP asynchronous-work field, capability, event or notification name.",
    },
    {
      file: "packages/runner/src/host/background-work.ts",
      token: "async_task_state_update",
      reason:
        "Pinned upstream ACP asynchronous-work field, capability, event or notification name.",
    },
    {
      file: "packages/runner/src/host/background-work.ts",
      token: "taskType",
      reason:
        "Pinned upstream ACP asynchronous-work field, capability, event or notification name.",
    },
    {
      file: "packages/runner/src/host/driver.ts",
      token: "task-notification",
      reason:
        "Pinned upstream ACP asynchronous-work field, capability, event or notification name.",
    },
  ],
  "host environment contract": [
    {
      file: "packages/runner/src/host/driver.ts",
      token: "DISPATCH_ACP_SESSION_NOTICES",
      reason:
        "Existing host environment/configuration contract; retain exact key, shell profile bytes or PATH diagnostic.",
    },
    {
      file: "packages/runner/src/host/host-command.ts",
      token: "DISPATCH_AGENT_HOST_COMMAND",
      reason:
        "Existing host environment/configuration contract; retain exact key, shell profile bytes or PATH diagnostic.",
    },
    {
      file: "packages/runner/src/host/host-command.ts",
      token: '[ -f "$HOME/.dispatch/env" ] && . "$HOME/.dispatch/env"; ',
      reason:
        "Existing host environment/configuration contract; retain exact key, shell profile bytes or PATH diagnostic.",
    },
    {
      file: "packages/runner/src/host/host-command.ts",
      token:
        'test -f "$HOME/.dispatch/env"; and source "$HOME/.dispatch/env"; ',
      reason:
        "Existing host environment/configuration contract; retain exact key, shell profile bytes or PATH diagnostic.",
    },
    {
      file: "packages/runner/src/host/host-env.ts",
      token: "DISPATCH_ACP_ADAPTER_COMMAND",
      reason:
        "Existing host environment/configuration contract; retain exact key, shell profile bytes or PATH diagnostic.",
    },
    {
      file: "packages/runner/src/host/host-env.ts",
      token: "DISPATCH_AGENT_ID",
      reason:
        "Existing host environment/configuration contract; retain exact key, shell profile bytes or PATH diagnostic.",
    },
    {
      file: "packages/runner/src/host/host-env.ts",
      token: "DISPATCH_FILES_DIR",
      reason:
        "Existing host environment/configuration contract; retain exact key, shell profile bytes or PATH diagnostic.",
    },
    {
      file: "packages/runner/src/host/host-env.ts",
      token: "DISPATCH_LOCAL_CA_CERTIFICATE",
      reason:
        "Existing host environment/configuration contract; retain exact key, shell profile bytes or PATH diagnostic.",
    },
    {
      file: "packages/runner/src/host/main.ts",
      token:
        "Agent executable search PATH; configure additional runtimes in ~/.dispatch/env",
      reason:
        "Existing host environment/configuration contract; retain exact key, shell profile bytes or PATH diagnostic.",
    },
  ],
  "host launch input": [
    {
      file: "packages/runner/src/host/host-env.ts",
      token: "personaContext",
      reason:
        "Persisted main-era host launch field; retain its exact JSON key.",
    },
    {
      file: "packages/runner/src/host/main.ts",
      token: "personaContext",
      reason:
        "Persisted main-era host launch field; retain its exact JSON key.",
    },
  ],
} as const;

export function isHostCompatibilityToken(file: string, token: string): boolean {
  return Object.values(hostVocabularyCompatibility).some((entries) =>
    entries.some((entry) => entry.file === file && entry.token === token)
  );
}

export const workloadVocabularyCompatibility = [
  {
    file: "packages/runner/src/host/local-host-entry.ts",
    token: "DISPATCH_FILES_DIR",
    reason: "The host reproduces this environment, build or on-disk name.",
  },
  {
    file: "packages/runner/src/host/local-host-entry.ts",
    token: "DISPATCH_LOCAL_CA_CERTIFICATE",
    reason: "The host reproduces this environment, build or on-disk name.",
  },
  {
    file: "packages/runner/src/host/local-host-entry.ts",
    token: "DISPATCH_LOCAL_RUNNER_LAUNCH",
    reason: "The host reproduces this environment, build or on-disk name.",
  },
  {
    file: "packages/runner/src/host/local-host-entry.ts",
    token: "personaContext",
    reason: "Existing records or wire frames carry this field.",
    temporary: true,
  },
  {
    file: "packages/runner/src/workload/agents/checkout-command-executor.ts",
    token: "DISPATCH_AGENT_ID",
    reason: "The host reproduces this environment, build or on-disk name.",
  },
  {
    file: "packages/runner/src/workload/agents/checkout-worker.ts",
    token: "Persona directory must remain inside the current workspace.",
    reason: "Preserve the diagnostic shown to the user.",
    temporary: true,
  },
  {
    file: "packages/runner/src/workload/agents/checkout-worker.ts",
    token: "Refusing to overwrite a symlinked persona file.",
    reason: "Preserve the diagnostic shown to the user.",
    temporary: true,
  },
  {
    file: "packages/runner/src/workload/agents/default-branch-files.ts",
    token:
      "Could not refresh personas from origin. Using cached definitions; retry is delayed automatically.",
    reason: "Preserve the diagnostic shown to the user.",
    temporary: true,
  },
  {
    file: "packages/runner/src/workload/agents/default-branch-files.ts",
    token:
      "Could not store the persona catalog. Check repository cache permissions.",
    reason: "Preserve the diagnostic shown to the user.",
    temporary: true,
  },
  {
    file: "packages/runner/src/workload/agents/default-branch-files.ts",
    token: "Persona catalog exceeds the 100-file or 4 MiB limit.",
    reason: "Preserve the diagnostic shown to the user.",
    temporary: true,
  },
  {
    file: "packages/runner/src/workload/agents/default-branch-files.ts",
    token: "persona-catalog",
    reason: "The host reproduces this environment, build or on-disk name.",
    temporary: true,
  },
  {
    file: "packages/runner/src/workload/agents/engine-login.ts",
    token: 'chmod 600 "$REAL/.auth.json.dispatch"',
    reason: "The host reproduces this environment, build or on-disk name.",
  },
  {
    file: "packages/runner/src/workload/agents/engine-login.ts",
    token: 'cp "$STAGE/auth.json" "$REAL/.auth.json.dispatch"',
    reason: "The host reproduces this environment, build or on-disk name.",
  },
  {
    file: "packages/runner/src/workload/agents/engine-login.ts",
    token: 'mv -f "$REAL/.auth.json.dispatch" "$REAL/auth.json"',
    reason: "The host reproduces this environment, build or on-disk name.",
  },
  {
    file: "packages/runner/src/workload/agents/engine-updates.ts",
    token:
      'IFS= read -r dispatch_start || exit 1; [ "$dispatch_start" = start ] || exit 1; exec "$@" </dev/null',
    reason: "The host reproduces this environment, build or on-disk name.",
  },
  {
    file: "packages/runner/src/workload/agents/provider-plans.ts",
    token:
      "ChatGPT did not answer the reset request, so whether a reset was spent is unknown. Check the plan limits before trying again.",
    reason:
      "Existing tool arguments, response fields or provider diagnostics use these bytes.",
  },
  {
    file: "packages/runner/src/workload/agents/provider-plans.ts",
    token:
      "ChatGPT refused the reset request, so whether a reset was spent is unknown. Check the plan limits before trying again.",
    reason:
      "Existing tool arguments, response fields or provider diagnostics use these bytes.",
  },
  {
    file: "packages/runner/src/workload/agents/provider-plans.ts",
    token:
      "ChatGPT's answer to the reset request could not be read. Check the plan limits before trying again.",
    reason:
      "Existing tool arguments, response fields or provider diagnostics use these bytes.",
  },
  {
    file: "packages/runner/src/workload/agents/provider-plans.ts",
    token: "ChatGPT-Account-Id",
    reason:
      "Existing tool arguments, response fields or provider diagnostics use these bytes.",
  },
  {
    file: "packages/runner/src/workload/agents/provider-plans.ts",
    token:
      "Codex is not signed in with a ChatGPT plan on this machine, so no reset can be used.",
    reason:
      "Existing tool arguments, response fields or provider diagnostics use these bytes.",
  },
  {
    file: "packages/runner/src/workload/agents/remote/engine-runner-executor.ts",
    token: "Update command failed. Review the output before retrying.",
    reason: "Preserve the diagnostic shown to the user.",
  },
  {
    file: "packages/runner/src/workload/agents/remote/session-storage.ts",
    token: "--template=",
    reason:
      "Existing tool arguments, response fields or provider diagnostics use these bytes.",
  },
  {
    file: "packages/runner/src/workload/agents/remote/session-storage.ts",
    token: "reviewBase",
    reason: "Existing records or wire frames carry this field.",
  },
  {
    file: "packages/runner/src/workload/agents/remote/session-supervisor.ts",
    token: "DISPATCH_API_BASE",
    reason: "The host reproduces this environment, build or on-disk name.",
  },
  {
    file: "packages/runner/src/workload/agents/remote/session-supervisor.ts",
    token: "DISPATCH_API_URL",
    reason: "The host reproduces this environment, build or on-disk name.",
  },
  {
    file: "packages/runner/src/workload/agents/remote/session-supervisor.ts",
    token: "DISPATCH_LOCAL_CA_CERTIFICATE",
    reason: "The host reproduces this environment, build or on-disk name.",
  },
  {
    file: "packages/runner/src/workload/agents/remote/session-supervisor.ts",
    token: "DISPATCH_PORT",
    reason: "The host reproduces this environment, build or on-disk name.",
  },
  {
    file: "packages/runner/src/workload/agents/remote/session-supervisor.ts",
    token: "DISPATCH_SCHEME",
    reason: "The host reproduces this environment, build or on-disk name.",
  },
  {
    file: "packages/runner/src/workload/agents/remote/session-supervisor.ts",
    token: "agt_",
    reason: "The legacy session directory keeps this prefix.",
    temporary: true,
  },
  {
    file: "packages/runner/src/workload/agents/remote/session-supervisor.ts",
    token: "personaContext",
    reason: "Existing records or wire frames carry this field.",
    temporary: true,
  },
  {
    file: "packages/runner/src/workload/agents/remote/update-keys.ts",
    token: "DISPATCH_COMPILED_RUNNER_DEV_KEY",
    reason: "The host reproduces this environment, build or on-disk name.",
  },
  {
    file: "packages/runner/src/workload/agents/remote/update-probe.ts",
    token: "--property=TasksMax=32",
    reason:
      "Existing tool arguments, response fields or provider diagnostics use these bytes.",
  },
  {
    file: "packages/runner/src/workload/agents/remote/update-stage-cli.ts",
    token: "DISPATCH_RUNNER_UPDATE_TEST_HOST",
    reason: "The host reproduces this environment, build or on-disk name.",
  },
  {
    file: "packages/runner/src/workload/agents/remote/update-stage-cli.ts",
    token: "DISPATCH_RUNNER_UPDATE_TEST_ROOT",
    reason: "The host reproduces this environment, build or on-disk name.",
  },
  {
    file: "packages/runner/src/workload/files/workspace-file-index.ts",
    token: ".dispatch",
    reason: "The host reproduces this environment, build or on-disk name.",
  },
  {
    file: "packages/runner/src/workload/shared/github/pr.ts",
    token:
      "number,url,title,state,isDraft,reviewDecision,mergeStateStatus,mergeable,autoMergeRequest,headRefName,baseRefName,statusCheckRollup",
    reason:
      "Existing tool arguments, response fields or provider diagnostics use these bytes.",
  },
  {
    file: "packages/runner/src/workload/shared/github/pr.ts",
    token: "reviewDecision",
    reason:
      "Existing tool arguments, response fields or provider diagnostics use these bytes.",
  },
  {
    file: "packages/runner/src/workload/shared/icon-scan.ts",
    token: ".dispatch",
    reason: "The repository's config folder name on disk.",
  },
  {
    file: "packages/runner/src/workload/shared/lib/tool-environment.ts",
    token: "DISPATCH_AGENT_ID",
    reason: "The environment key agents' tools read.",
  },
] as const;

export function isRunnerCompatibilityToken(
  file: string,
  token: string
): boolean {
  return (
    isHostCompatibilityToken(file, token) ||
    workloadVocabularyCompatibility.some(
      (entry) => entry.file === file && entry.token === token
    )
  );
}
