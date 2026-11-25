/*
 * Wire v1 frames as Dispatch and the v1 runner send them today. Every
 * request is checked with the v1 decoder (`parseServiceFrame`) and every
 * result with the v1 consumer's validator before the codec sees it.
 */
import type {
  CheckoutView,
  Command,
  UpdateServiceFrame,
  UpdateStatusFrame,
} from "@dispatch/runner-protocol";

const workspace = "@session";
const agentId = "agt_fixture1";
const state = "a".repeat(64);
const sha = "b".repeat(40);
const context = "c".repeat(64);

export type ResultFixture = {
  command: Command;
  /** The v1 result value. */
  value: string | boolean;
  /** Data lines sent before the result. */
  events?: unknown[];
};

const s = (kind: string, extra: object = {}) =>
  ({ workspace, agentId, kind, ...extra }) as Command;
const view = (query: CheckoutView) => s("viewCheckout", { query });
const engine = (operation: object) =>
  ({ workspace, agentId: "runner", kind: "engine", operation }) as Command;
const github = (operation: object) =>
  ({ workspace, agentId: "runner", kind: "github", operation }) as Command;
const json = JSON.stringify;
const loginView = {
  id: "login-1",
  engine: "codex",
  status: "waiting",
  needsCode: false,
  url: "https://auth.example/device",
  userCode: "ABCD-1234",
};
const pr = { owner: "acme", repo: "app", number: 7 };
const diffFile = {
  path: "src/a.ts",
  status: "modified",
  added: 2,
  deleted: 1,
  diff: "@@ -1 +1,2 @@\n-a\n+b\n+c\n",
};

export const results: ResultFixture[] = [
  // Additive current-runner calls use the existing authenticated engine envelope.
  ...[
    {
      op: "engine.update.inspect",
      request: { engine: "codex" },
      result: {
        realPath: null,
        source: "unknown",
        canUpdate: false,
        reason: "manual",
        command: "fixture",
        latestKey: "unknown:fixture",
        target: "fixture",
      },
    },
    {
      op: "engine.update.spawn",
      request: {
        requestId: "fixture",
        command: { executable: "fixture", args: [] },
        timeoutMs: 1000,
      },
      result: { operationId: "fixture", pid: 123 },
    },
    {
      op: "engine.update.release",
      request: { operationId: "fixture" },
      result: {},
    },
    {
      op: "engine.update.probe",
      request: { pids: [123] },
      result: { alive: [false], version: null },
    },
    {
      op: "engine.operation",
      request: { operationId: "fixture" },
      result: {
        type: "operation_state",
        operationId: "fixture",
        running: false,
        output: "fixture",
        outputOffset: 7,
        result: { exitCode: 0, stdout: "fixture", stderr: "" },
      },
    },
    {
      op: "engine.plugin.apply",
      request: {
        engine: "codex",
        plugin: "dispatch@dispatch",
        action: "update",
        requestId: "fixture",
      },
      result: {
        agentType: "codex",
        installed: false,
        enabled: false,
        currentVersion: null,
        latestVersion: null,
        updateAvailable: false,
        actions: ["install"],
        detectionError: "fixture probe detail",
        error: "fixture curated failure",
        ranCommands: ["plugin marketplace upgrade dispatch --json"],
        probeFailed: true,
      },
    },
  ].map(({ op, request, result }) => ({
    command: engine({ type: "contract", call: { op, request } }),
    value: json({ ok: true, result }),
  })),
  {
    command: s("sessionObservation", {
      operation: { op: "session.list", request: { owner: null } },
    }),
    value: json({
      sessions: [
        {
          session: agentId,
          state: "live",
          launchId: "0b6f3c1e-8f7a-4c2d-9e1b-5a4d3c2b1a00",
        },
      ],
    }),
  },
  {
    command: s("sessionObservation", {
      operation: { op: "session.sample", request: { sessions: [agentId] } },
    }),
    value: json({
      samples: [
        {
          session: agentId,
          supported: true,
          cpuPercent: 15.2,
          rssBytes: 2048,
          processCount: 2,
          sampledAt: 1000,
          error: null,
        },
      ],
    }),
  },
  {
    command: s("stop", {
      force: true,
      expectedOwner: "controller-a",
      expectedLaunchId: "0b6f3c1e-8f7a-4c2d-9e1b-5a4d3c2b1a00",
    }),
    value: true,
  },
  {
    command: s("launch", {
      launch: {
        agentId,
        engine: "claude",
        fullAccess: true,
        model: "opus",
        effort: "high",
        systemPrompt: "system",
        personaContext: "first",
        mcp: { url: "https://dispatch.example/mcp", token: "t", name: "srv" },
        resumeSessionId: null,
        repository: {
          url: "https://github.com/acme/app",
          checkout: { kind: "new", branch: "feature", base: "main" },
        },
        prepareWorkspace: true,
        launchId: "0b6f3c1e-8f7a-4c2d-9e1b-5a4d3c2b1a00",
        owner: "controller-a",
      },
    }),
    value: true,
  },
  {
    command: s("launch", {
      launch: {
        agentId,
        engine: "codex",
        model: null,
        systemPrompt: null,
        resumeSessionId: "session-9",
        mcp: { url: "https://dispatch.example/mcp", token: "t" },
      },
    }),
    value: true,
  },
  {
    command: s("launch", {
      launch: {
        agentId,
        engine: "opencode",
        fullAccess: false,
        model: "m",
        effort: null,
        systemPrompt: "s",
        personaContext: null,
        resumeSessionId: null,
        useWorktreeOf: "agt_owner",
      },
    }),
    value: true,
  },
  {
    command: s("gitQuery", {
      operation: {
        op: "git.defaultBranch",
        request: { target: { path: "/srv/work" } },
      },
    }),
    value: json({ data: { branch: "trunk" } }),
  },
  {
    command: s("gitQuery", {
      operation: {
        op: "git.branches",
        request: { target: { repository: "https://example.com/repo" } },
      },
    }),
    value: json({ data: { branches: ["trunk"], defaultBranch: "trunk" } }),
  },
  {
    command: s("gitQuery", {
      operation: {
        op: "git.base",
        request: {
          target: { session: agentId },
          requested: null,
          fallback: ["trunk"],
        },
      },
    }),
    value: json({ data: { base: "trunk" } }),
  },
  {
    command: s("checkoutWrite", {
      operation: {
        op: "checkout.write",
        request: {
          target: { session: agentId, checkout: "current" },
          path: ".agents/personas/x.md",
          data: "# x",
          expectedDigest: null,
        },
      },
    }),
    value: json({ data: { digest: "ab".repeat(32) } }),
  },
  {
    command: s("checkoutWrite", {
      operation: {
        op: "checkout.write",
        request: {
          target: { session: agentId, checkout: "current" },
          path: ".agents/personas/x.md",
          data: "# x",
          expectedDigest: "cd".repeat(32),
        },
      },
    }),
    value: json({
      error: { code: "stale", message: "The file changed since it was read." },
    }),
  },
  {
    command: s("repositoryFiles", {
      operation: {
        op: "checkout.defaultFiles",
        request: {
          target: { repository: "https://example.com/repo" },
          dirs: [".agents/personas"],
          wait: true,
        },
      },
    }),
    value: json({
      data: {
        hasOrigin: true,
        files: [{ path: ".agents/personas/x.md", content: "# x" }],
        warnings: [],
        refreshing: false,
        updatedAt: 1,
        truncated: false,
      },
    }),
  },
  {
    command: s("workspacePrepare", {
      operation: {
        source: {
          repository: "https://github.com/acme/app",
          checkout: { kind: "new", branch: "feature", base: "main" },
        },
        copyIgnored: [".env"],
        installDependencies: true,
      },
    }),
    value: json({
      data: {
        path: "/srv/work",
        moved: false,
        origin: "https://github.com/acme/app",
      },
    }),
  },
  { command: s("workspaceResume"), value: json({ data: null }) },
  {
    command: s("workspaceResume"),
    value: json({
      error: { code: "conflict", message: "The checkout changed." },
    }),
  },
  { command: s("attach"), value: true },
  { command: s("alive"), value: true },
  { command: s("alive"), value: false },
  { command: s("stop", { force: false }), value: true },
  { command: s("stop", { force: true }), value: true },
  { command: s("discard"), value: true },
  { command: s("log"), value: "\n\nHost log (last 20 lines):\nready" },
  {
    command: s("openTerminal"),
    value: json({ cwd: "/srv/work", host: "box", user: "worker" }),
  },
  { command: s("watchCheckout"), value: true },
  {
    command: view({ kind: "directory", path: "" }),
    value: json({
      data: {
        truncated: false,
        entries: [
          { name: "src", path: "src", kind: "directory" },
          { name: "README.md", path: "README.md", kind: "file" },
        ],
      },
    }),
  },
  {
    command: view({ kind: "directory", path: "missing" }),
    value: json({ status: 404, error: "Not found." }),
  },
  {
    command: view({ kind: "preview", path: "README.md" }),
    value: json({ data: { kind: "text", size: 5, text: "hello" } }),
  },
  {
    command: view({ kind: "index", generation: "g1" }),
    value: json({
      data: { source: "git", paths: ["README.md"], truncated: false },
    }),
  },
  {
    command: view({
      kind: "stats",
      baseBranch: "main",
      includeUncommitted: true,
    }),
    value: json({
      data: {
        files: 3,
        added: 10,
        deleted: 2,
        excludingTests: { files: 2, added: 8, deleted: 1 },
        computedAt: 1700000000000,
        outcome: "success",
      },
    }),
  },
  {
    command: view({
      kind: "stats",
      baseBranch: null,
      includeUncommitted: false,
    }),
    value: json({ data: null }),
  },
  {
    command: view({
      kind: "diff",
      baseBranch: "main",
      includeUncommitted: true,
      ignoreWhitespace: false,
    }),
    value: json({
      data: {
        baseRef: "origin/main",
        files: [
          { ...diffFile, truncated: false, isTest: false },
          {
            path: "logo.png",
            status: "added",
            added: 0,
            deleted: 0,
            diff: null,
            truncated: false,
            isTest: false,
            image: { revision: sha, oldSize: null, newSize: 120 },
          },
        ],
        truncatedFileCount: 1,
      },
    }),
  },
  {
    command: view({
      kind: "diff",
      baseBranch: null,
      includeUncommitted: false,
      ignoreWhitespace: true,
    }),
    value: json({ data: { baseRef: null, files: [] } }),
  },
  {
    command: view({
      kind: "fileDiff",
      path: "src/a.ts",
      baseBranch: "main",
      includeUncommitted: true,
      ignoreWhitespace: true,
    }),
    value: json({ data: diffFile }),
  },
  {
    command: view({
      kind: "image",
      path: "logo.png",
      side: "new",
      baseBranch: "main",
      includeUncommitted: false,
    }),
    value: json({ data: "iVBORw0KGgo=" }),
  },
  {
    command: s("inspectCheckout", {
      query: { kind: "changes", baseBranch: "main" },
    }),
    value: json({
      kind: "changes",
      baseRef: "origin/main",
      head: sha,
      stateId: state,
      files: ["src/a.ts"],
    }),
  },
  {
    command: s("inspectCheckout", {
      query: { kind: "readFile", path: ".agents/personas/x.md" },
    }),
    value: json({ kind: "readFile", content: "# x" }),
  },
  {
    command: s("inspectCheckout", {
      query: { kind: "readFile", path: "missing.md" },
    }),
    value: json({ kind: "readFile", content: null }),
  },
  {
    command: s("inspectCheckout", {
      query: {
        kind: "defaultBranchFiles",
        directories: [".agents/personas"],
        waitForRefresh: false,
      },
    }),
    value: json({
      kind: "defaultBranchFiles",
      hasOrigin: true,
      files: [{ path: ".agents/personas/x.md", content: "# x" }],
      warnings: [],
      refreshing: true,
      updatedAt: 1700000000000,
      truncated: false,
    }),
  },
  {
    command: s("sessionCheckout", {
      operation: { kind: "context", checkout: "current" },
    }),
    value: json({
      repoRoot: "/srv/work/app",
      worktreePath: "/srv/work/app",
      worktreeName: "app",
      branch: "feature",
      isWorktree: false,
      repoIconPath: "favicon.svg",
    }),
  },
  {
    command: s("sessionCheckout", { operation: { kind: "context" } }),
    value: json(null),
  },
  {
    command: s("sessionCheckout", { operation: { kind: "describe" } }),
    value: json({
      path: "/srv/work/app",
      moved: false,
      origin: "https://github.com/acme/app",
      repositoryRoot: "/srv/work/app",
      checkoutRoot: "/srv/work/app",
      branch: "feature",
    }),
  },
  {
    command: s("sessionCheckout", {
      operation: { kind: "select", path: "/srv/other" },
    }),
    value: json({ path: "/srv/other", moved: true, origin: null }),
  },
  {
    command: s("sessionCheckout", {
      operation: { kind: "select", path: null },
    }),
    value: json({ path: "/srv/work/app", moved: false, origin: null }),
  },
  {
    command: s("workspaceRelease", {
      operation: { deleteBranch: true, originalBranch: "feature" },
    }),
    value: json({ removed: true }),
  },
  {
    command: s("checkoutRelease", { operation: { kind: "observe" } }),
    value: json({
      ownership: "owned",
      owner: "agt_fixture1",
      borrowers: ["agt_borrower"],
      checkout: {
        path: "/srv/work/app",
        branch: "feature",
        stateId: state,
        unmerged: true,
        changedFiles: ["a"],
        uncommittedFiles: [],
      },
    }),
  },
  {
    command: s("checkoutRelease", {
      operation: { kind: "release", expectedState: state },
    }),
    value: "inUse",
  },
  {
    command: s("checkoutRelease", {
      operation: { kind: "release", expectedState: state },
    }),
    value: "retained",
  },
  {
    command: s("checkoutRelease", {
      operation: { kind: "release", expectedState: null },
    }),
    value: "released",
  },
  {
    command: s("checkoutCommand", {
      operation: {
        checkout: "effective",
        path: ".dispatch/tools.json",
        kind: "read",
      },
    }),
    value: json({ content: "{}", state }),
  },
  {
    command: s("checkoutCommand", {
      operation: {
        checkout: "moved",
        path: ".dispatch/tools.json",
        kind: "read",
      },
    }),
    value: "null",
  },
  {
    command: s("checkoutCommand", {
      operation: {
        checkout: "launch",
        path: ".dispatch/tools.json",
        kind: "run",
        state,
        argv: ["./bin/hook", "stop"],
      },
    }),
    value: json({ exitCode: 0, stdout: "ok", stderr: "", truncated: false }),
  },
  {
    command: s("sessionFile", {
      operation: { kind: "deliver", name: "report.md", data: "aGVsbG8=" },
    }),
    value: "/var/lib/runner/agents/x/files/report.md",
  },
  {
    command: s("sessionFile", {
      operation: { kind: "collect", path: "/srv/work/app/out.png" },
    }),
    value: "aGVsbG8=",
  },
  {
    command: engine({ type: "status" }),
    value: json({ ok: true }),
    events: [
      {
        type: "inventory",
        entries: [
          {
            id: "claude",
            label: "Claude Code",
            installed: true,
            signedIn: true,
            version: "2.0.0",
            actions: ["update"],
          },
        ],
      },
    ],
  },
  {
    command: engine({ type: "install", engine: "codex" }),
    value: json({ ok: true, operationId: "op-1", message: "Installed." }),
  },
  {
    command: engine({ type: "update", engine: "claude" }),
    value: json({ ok: false, error: "No managed update command." }),
  },
  {
    command: engine({ type: "login_start", engine: "codex", restart: true }),
    value: json({ ok: true, login: loginView }),
  },
  {
    command: engine({ type: "login_start", engine: "codex" }),
    value: json({ ok: true, login: loginView }),
  },
  {
    command: engine({ type: "login_submit", loginId: "login-1", code: "x" }),
    value: json({ ok: true, login: loginView }),
  },
  {
    command: engine({ type: "login_status", loginId: "login-1" }),
    value: json({ ok: true, login: loginView }),
  },
  {
    command: engine({ type: "login_cancel", loginId: "login-1" }),
    value: json({ ok: true, login: { ...loginView, status: "cancelled" } }),
  },
  {
    command: engine({ type: "model_catalog", engine: "claude", model: "opus" }),
    value: json({
      ok: true,
      capability: {
        type: "model_catalog",
        catalog: {
          defaultModel: "opus",
          models: [
            {
              id: "opus",
              label: "Opus",
              effort: [{ value: "high", name: "High" }],
            },
          ],
        },
      },
    }),
  },
  {
    command: engine({ type: "provider_usage" }),
    value: json({
      ok: true,
      capability: {
        type: "provider_usage",
        usage: {
          checkedAt: "2026-11-22T00:00:00Z",
          providers: [
            {
              engine: "codex",
              plan: "pro",
              observedAt: null,
              windows: [
                { id: "5h", label: "5h", usedPercent: 10, resetsAt: null },
              ],
            },
          ],
          codexResetAccount: "acct",
        },
      },
    }),
  },
  {
    command: engine({
      type: "codex_reset",
      account: "acct",
      requestId: "2d8b5e3a-0b9c-4e4f-9a3d-7c6f5e4d3c22",
    }),
    value: json({
      ok: true,
      capability: { type: "codex_reset", code: "ok", windowsReset: 2 },
    }),
  },
  {
    command: engine({
      type: "codex_reset",
      account: "acct",
      requestId: "3e9c6f4b-1cad-4f5a-8b4e-8d7a6f5e4d33",
    }),
    value: json({
      ok: false,
      reason: "account_changed",
      error: "The Codex account changed. Refresh usage before trying again.",
    }),
  },
  {
    command: engine({ type: "plugin_status", engine: "claude", plugin: "p@m" }),
    value: json({
      ok: false,
      unsupported: true,
      error: "Plugin management is unavailable on this runner.",
    }),
  },
  {
    command: engine({ type: "plugin_install", engine: "codex", plugin: "p@m" }),
    value: json({
      ok: true,
      capability: {
        type: "plugin_status",
        status: {
          installed: true,
          enabled: true,
          currentVersion: "1.0.0",
          latestVersion: "1.0.0",
          updateAvailable: false,
          actions: ["update"],
        },
      },
    }),
  },
  {
    command: engine({ type: "plugin_update", engine: "claude", plugin: "p@m" }),
    value: json({ ok: false, error: "Could not read plugin status." }),
  },
  {
    command: github({ type: "status" }),
    value: json({ status: "signed-in", login: "octo" }),
  },
  {
    command: github({ type: "login" }),
    value: json({
      status: "pending",
      code: "ABCD-1234",
      verificationUrl: "https://github.com/login/device",
    }),
  },
  {
    command: github({ type: "cancel" }),
    value: json({ status: "signed-out" }),
  },
  {
    command: github({ type: "logout" }),
    value: json({ status: "signed-out" }),
  },
  {
    command: github({ type: "repositorySearch", query: "app" }),
    value: json({
      repositories: [{ name: "acme/app", url: "https://github.com/acme/app" }],
    }),
  },
  {
    command: github({ type: "repositoryBranches", owner: "acme", repo: "app" }),
    value: json({ branches: ["main", "feature"], defaultBranch: "main" }),
  },
  {
    command: github({ type: "pullRequestHead", ...pr }),
    value: json({ url: "https://github.com/acme/app", branch: "feature" }),
  },
  {
    command: github({
      type: "pullRequestStatus",
      ...pr,
      withCredentialContext: true,
      refreshWatch: true,
    }),
    value: json({
      state: "OPEN",
      draft: false,
      title: "Fix",
      head: sha,
      rollup: [],
      credentialContext: context,
    }),
  },
  {
    command: github({ type: "pullRequestStatus", ...pr }),
    value: json({
      state: null,
      draft: false,
      title: null,
      head: null,
      rollup: null,
    }),
  },
  {
    command: github({ type: "pullRequestDetails", ...pr }),
    value: json({
      credentialContext: context,
      number: 7,
      title: "Fix",
      body: "",
      baseRefName: "main",
      headRefName: "feature",
      baseRefOid: sha,
      headRefOid: sha,
      additions: 1,
      deletions: 0,
      files: [{ path: "a", additions: 1, deletions: 0 }],
    }),
  },
  {
    command: github({
      type: "pullRequestDiff",
      ...pr,
      base: sha,
      head: sha,
      credentialContext: context,
    }),
    value: json({
      files: [{ path: "a", additions: 1, deletions: 0, patch: "+a" }],
    }),
  },
  {
    command: github({
      type: "pullRequestDiff",
      ...pr,
      base: sha,
      head: sha,
      credentialContext: context,
    }),
    value: json(null),
  },
];

/** v1 commands with no contract operation; passed through unchanged. */
export const legacy: Command[] = [
  s("repo"),
  s("inspectCheckout", { query: { kind: "listFiles", path: ".agents" } }),
  s("inspectCheckout", { query: { kind: "roots" } }),
  github({ type: "watchPullRequests", targets: [pr] }),
];

const target = {
  version: "1.7.33",
  os: "linux" as const,
  arch: "x64" as const,
  sha256: "d".repeat(64),
  revision: sha,
};
export const updates: UpdateServiceFrame[] = [
  {
    type: "update_offer",
    attemptId: "1c7a4d2f-9a8b-4d3e-8f2c-6b5e4d3c2b11",
    target,
    retry: false,
  },
  {
    type: "update_fence",
    attemptId: "1c7a4d2f-9a8b-4d3e-8f2c-6b5e4d3c2b11",
    retainSessions: true,
  },
  {
    type: "update_activate",
    attemptId: "1c7a4d2f-9a8b-4d3e-8f2c-6b5e4d3c2b11",
  },
  {
    type: "update_confirm",
    attemptId: "1c7a4d2f-9a8b-4d3e-8f2c-6b5e4d3c2b11",
    revision: sha,
    sha256: "d".repeat(64),
  },
  {
    type: "update_cancel",
    attemptId: "1c7a4d2f-9a8b-4d3e-8f2c-6b5e4d3c2b11",
    reason: "policy_changed",
  },
];

export const statuses: UpdateStatusFrame[] = [
  {
    type: "update_status",
    attemptId: "1c7a4d2f-9a8b-4d3e-8f2c-6b5e4d3c2b11",
    phase: "deferred",
    reason: "fence_ready",
    installed: { version: "1.7.32", revision: sha, sha256: "e".repeat(64) },
    retained: [
      {
        sessionId: "agt_fixture1",
        instanceId: "4fad7a5c-2dbe-4a6b-9c5f-9e8b7a6f5e44",
      },
    ],
    requiresQuiescence: true,
  },
  {
    type: "update_status",
    attemptId: "1c7a4d2f-9a8b-4d3e-8f2c-6b5e4d3c2b11",
    phase: "confirmed",
    installed: { version: "1.7.33", revision: sha, sha256: "d".repeat(64) },
  },
];
