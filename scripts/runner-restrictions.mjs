// Appendix D, part 2. Keep a named rule live until its last source anchor is
// gone. These anchors detect known restrictions; T06 supplies behavioral parity.
const server = "apps/server/src/";
const web = "apps/web/src/components/app/";
const protocol = "packages/runner-protocol/src/";
const admission = server + "agents/launch-admission.ts";
const runtime = server + "agents/acp/runtime.ts";
const manager = server + "agents/manager.ts";
const runner = server + "agents/remote/runner.ts";
const supervisor = server + "agents/remote/session-supervisor.ts";
const mcp = server + "routes/mcp.ts";

export const archiveReleaseRestriction = {
  file: supervisor,
  kind: "R7 restriction",
  detail: "N35 Runner archive conditionally releases and defers to borrowers",
  task: "T20",
  count: 1,
};

const rules = [
  [
    "N2",
    "Launch cwd overwritten",
    "T36",
    [admission, "cwd: runner ? sourceCwd : (requestedCwd ?? sourceWorkdir)"],
  ],
  [
    "N3",
    "Runner storage admission restricts launches",
    "T25",
    [admission, 'return reject("runnerStorage")'],
  ],
  [
    "N4",
    "Runner parent binding restrictions",
    "T36",
    [admission, 'return reject("independentBinding")'],
    [admission, 'return reject("childBinding")'],
  ],
  [
    "N7",
    "Managed runner cross-project task refusal",
    "T25",
    [admission, "if (managed && projectId && projectId !== taskProjectId)"],
  ],
  [
    "N8",
    "Create form gates project and checkout options",
    "T38",
    [web + "use-create-agent-form.ts", "remote && !managedSession ? null"],
  ],
  [
    "N9",
    "Selected workspace is confined",
    "T16",
    [supervisor, "Directory is outside the bound runner checkout."],
  ],
  [
    "N12",
    "Runner checkout hardens Git configuration",
    "T19",
    [runner, '"core.hooksPath=/dev/null"'],
    [runner, 'GIT_CONFIG_GLOBAL: "/dev/null"'],
  ],
  [
    "N13",
    "Checkout reply and watch limits",
    "T09",
    // Streamed reads bypass these v1 reply anchors. The legacy reply path,
    // image/default-file/metadata reads and watch still use them.
    [
      protocol + "checkout-view.ts",
      "MAX_CHECKOUT_VIEW_BYTES = 16 * 1024 * 1024",
    ],
    [protocol + "checkout.ts", "value.names.length <= 1024"],
    [protocol + "checkout.ts", "DEFAULT_BRANCH_REPLY_BYTES = 4 * 1024 * 1024"],
    [protocol + "checkout.ts", "encode(value.content).length <= 256 * 1024"],
    [runner, "if (watches.size >= 512)"],
  ],
  [
    "N14",
    "Runner repo tool and manifest limits",
    "T14",
    // Fallback only. Capable peers carry execution policy and stream output;
    // legacy peers still need the old limits during rolling updates.
    [runner, "legacy && legacyCheckoutCommands >= 32"],
    [
      protocol + "checkout-command.ts",
      "MAX_CHECKOUT_COMMAND_FILE_BYTES = 256 * 1024",
    ],
    [
      protocol + "checkout-command.ts",
      "MAX_CHECKOUT_COMMAND_OUTPUT_BYTES = 64 * 1024",
    ],
    [protocol + "checkout-command.ts", "REPO_TOOL_TIMEOUT_MS = 5 * 60_000"],
  ],
  [
    // Applies only to wire peers opening the legacy, uncredited channel.
    "N16",
    "Sixteen terminals per runner",
    "T21",
    [runner, "terminals.size >= 16"],
  ],
  [
    "N17",
    "Runner usage tools and capability limits",
    "T31",
    [mcp, "? usageForRunner(placement.runner)"],
    [runner, "capabilityRequests.size >= 8"],
  ],
  [
    "N18",
    "Runner Brain and task scope require a project",
    "T34",
    [mcp, "placement && agent.projectId && roots?.repositoryRoot"],
  ],
  [
    "N19",
    "Runner repository scope unavailable for listing and risk",
    "T34",
    [
      mcp,
      "const repoRoot = placement ? null : (roots?.repositoryRoot ?? null)",
    ],
  ],
  [
    "N22",
    "Runner checkout skips Git refresh",
    "T15",
    [
      manager,
      "if (remotePlacement(agent.cwd)) return; const result = agent.workspacePath",
    ],
  ],
  [
    "N23",
    "Runner persona authoring root is absent",
    "T35",
    [
      mcp,
      "const worktreeRoot = placement ? null : (roots?.checkoutRoot ?? null)",
    ],
  ],
  [
    "N24",
    "Runner persona resolution falls back",
    "T35",
    [
      server + "personas/persona-scope.ts",
      "if (target.cwd && !remotePlacement(target.cwd))",
    ],
  ],
  [
    "N25",
    "Workspace and copy actions hidden",
    "T37",
    [
      web + "agent-card-details.tsx",
      "!remoteLocation && <ChangeWorkspaceButton",
    ],
    [
      web + "agent-card-details.tsx",
      "!remoteLocation && agent.gitContext?.isWorktree",
    ],
  ],
  [
    "N26",
    "Runner screencast returns 409",
    "T39",
    [
      server + "routes/agents/streaming-routes.ts",
      "Playwright screencasts are unavailable for runner sessions.",
    ],
  ],
  [
    "N27",
    "Helper commands absent from runner PATH",
    "T24, T39",
    [supervisor, "pathPrefix: [],"],
  ],
  [
    "N28",
    "Project creation resolves only controller paths",
    "T17",
    [
      server + "routes/projects.ts",
      "const repoRoot = await resolveProjectRoot(input.repoRoot)",
    ],
  ],
  [
    "N29",
    "Capability-specific update refusals",
    "T40",
    [
      server + "agents/remote/service.ts",
      "Update the runner to transfer session files.",
    ],
    [admission, "Update the runner to launch with startup files."],
  ],
  [
    "N30",
    "Model learning local only",
    "T30",
    [manager, "learnCatalog && !remotePlacement(agent.cwd)"],
  ],
  [
    "N31",
    "Runner repository icons disabled",
    "T15",
    [supervisor, "repoIcon: false"],
  ],
  [
    "N32",
    "Runner IDE refusal",
    "T37",
    [web + "ide-launch-button.tsx", "if (runnerCheckout || !onLoopback)"],
  ],
  [
    "N33",
    "Runner stop waits for the remote request",
    "T26",
    [
      runtime,
      "if (placement) await heldSessionRequest(placement, operation); const entry = live.get(agentId)",
    ],
  ],
  [
    "N34",
    "Engine updates require configured commands",
    "T29",
    [
      server + "agents/remote/engine-runner-executor.ts",
      "No managed ${kind} command is configured",
    ],
  ],
  // These anchors remain only in the legacy checkoutRelease wire handler.
  [
    "N35",
    "Runner archive conditionally releases and defers to borrowers",
    "T20",
    [
      supervisor,
      "if (observed?.stateId !== expectedState || expectedState === null) {",
    ],
    [
      supervisor,
      'if ((await checkoutBorrowers(key)).length > 0) return "inUse";',
    ],
  ],
];

const normalize = (source) => source?.replace(/\s+/g, " ").trim();

// Existing enrolled wire budgets are retained by owner decision. These pairs
// exempt only their original declarations; copies in another file are hits.
const retained = [
  [
    "N13",
    protocol + "checkout-view.ts",
    "MAX_CHECKOUT_VIEW_BYTES = 16 * 1024 * 1024",
    "Enrolled view reply budget",
  ],
  [
    "N13",
    protocol + "checkout.ts",
    "value.names.length <= 1024",
    "Enrolled legacy listing reply budget",
  ],
  [
    "N13",
    protocol + "checkout.ts",
    "DEFAULT_BRANCH_REPLY_BYTES = 4 * 1024 * 1024",
    "Enrolled legacy default-branch reply budget",
  ],
  [
    "N13",
    protocol + "checkout.ts",
    "encode(value.content).length <= 256 * 1024",
    "Enrolled legacy file reply budget",
  ],
  [
    "N14",
    protocol + "checkout-command.ts",
    "MAX_CHECKOUT_COMMAND_FILE_BYTES = 256 * 1024",
    "Enrolled command manifest budget; local discovery is unlimited",
  ],
  [
    "N14",
    "packages/runner/src/workload/agents/remote/checkout-timeout.ts",
    "REPO_TOOL_TIMEOUT_MS = 5 * 60_000",
    "Existing enrolled command deadline",
  ],
  [
    "N26",
    server + "routes/agents/streaming-routes.ts",
    "Playwright screencasts are unavailable for runner sessions.",
    "deferred gap T39, owner decision",
  ],
];

export function misplacedRestrictions(file, source) {
  const text = normalize(source);
  return retained.flatMap(([id, owner, anchor]) =>
    file !== owner && text.includes(anchor)
      ? [
          {
            file,
            kind: "R7 restriction",
            detail: id + " " + anchor,
            task: id === "N26" ? "T39" : id === "N13" ? "T09" : "T14",
          },
        ]
      : []
  );
}

export function restrictionHits(read) {
  const sources = new Map();
  return rules.flatMap(([id, detail, task, ...anchors]) => {
    const live = anchors.some(([file, anchor]) => {
      if (
        retained.some(
          ([rule, owner, value]) =>
            rule === id && owner === file && value === anchor
        )
      )
        return false;
      if (!sources.has(file)) sources.set(file, normalize(read(file)));
      return sources.get(file)?.includes(normalize(anchor));
    });
    return live
      ? [
          {
            file: anchors[0][0],
            kind: "R7 restriction",
            detail: `${id} ${detail}`,
            task,
          },
        ]
      : [];
  });
}
