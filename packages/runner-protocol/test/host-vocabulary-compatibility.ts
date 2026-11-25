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
