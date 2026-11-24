import { isDeepStrictEqual } from "node:util";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { createSessionCore } from "@dispatch/runner/cli";
import {
  createSessionSupervisor,
  runnerStorageKey,
} from "../src/agents/remote/session-supervisor.js";
import { inspectCheckout } from "../src/agents/checkout-inspection.js";
import { writeCheckoutFile } from "../src/agents/checkout-worker.js";
import type { RunnerCallError } from "@dispatch/runner-protocol/contract";
import { REPO_TOOL_MANIFEST_PATH } from "../src/shared/mcp/repo-tools.js";
import baseline from "./fixtures/mcp-caller-parity-baseline.json";
import { useInjectApp } from "./helpers/inject-app.js";
import { createInertRuntime } from "../src/agents/runtime.js";

// Keep the production ACP admission rules enabled. Only substitute the engine
// runtime so neither launch calls nor job runs can start a provider process.
vi.mock("../src/agents/acp/runtime.js", async (original) => ({
  ...(await original<typeof import("../src/agents/acp/runtime.js")>()),
  createAcpRuntime: () => createInertRuntime(),
}));

const root = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "mcp-parity-"))
);
const callers = ["agt_parity_local", "agt_parity_runner"] as const;
const runnerState = path.join(root, "runner");
const runnerKey = runnerStorageKey(callers[1]);
const checkout = path.join(runnerState, "sessions", runnerKey, "checkout");
const outside = path.join(runnerState, "outside");
const state = "a".repeat(64);
const unexpected: string[] = [];

// Use the same persisted managed checkout shape as the runner supervisor tests.
const supervisor = await createSessionSupervisor(
  {
    state: runnerState,
    build: { version: "1.0.0", revision: state },
    uid: process.getuid!(),
    gid: process.getgid!(),
    ca: path.join(runnerState, "ca.pem"),
    bins: { claudeBin: "", codexBin: "" },
    sessions: createSessionCore,
    workspaces: new Set(),
    env: {},
    hostCommand: () => {
      throw new Error("The parity fixture does not start hosts");
    },
    async asWorkload(command, args) {
      if (command === "realpath") return realpath(args.at(-1)!);
      return execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    },
  },
  {
    acquire: () => () => {},
    alive: () => false,
    async cleanup() {},
    async cleanupLegacy() {},
    async stop() {},
    socketInUse: () => false,
    socketMatchesHost: () => false,
    async spawn() {
      throw new Error("The parity fixture does not start hosts");
    },
  }
);
afterAll(async () => {
  supervisor.close();
  await rm(root, { recursive: true, force: true });
});

const ctx = useInjectApp({
  setupAuth: false,
  env: {
    DISPATCH_STATE_DIR: path.join(root, "state"),
    DISPATCH_AGENT_RUNTIME: "acp",
  },
  enrolledRunner: {
    ready: {
      workspaces: ["@session"],
      managedWorkspace: true,
      checkoutInspection: true,
      checkoutMetadata: true,
      checkoutCommands: true,
      defaultBranchFiles: true,
      sessionCheckout: true,
      workspacePrepare: true,
      preparedLaunch: true,
      gitQueries: true,
      checkoutWrite: true,
      sessionFiles: true,
      sharedWorktree: true,
    },
    async answer(command) {
      switch (command.kind) {
        case "checkoutWrite": {
          // The runner's own workload write, in the session's checkout.
          const { target: _target, ...write } = command.operation.request;
          try {
            return JSON.stringify({
              data: await writeCheckoutFile(checkout, write),
            });
          } catch (error) {
            const { code, message, details } = error as RunnerCallError;
            return JSON.stringify({ error: { code, message, details } });
          }
        }
        case "gitQuery":
          expect(command.operation.op).toBe("git.defaultBranch");
          return JSON.stringify({ data: { branch: null } });
        case "workspacePrepare": {
          const { source, worktree } = command.operation;
          if ("directory" in source) {
            expect(source.directory).toBe(checkout);
            expect(worktree?.branch).toMatch(/^parity-(child|independent)$/);
          }
          return JSON.stringify({
            data: { path: checkout, moved: false, origin: null },
          });
        }
        case "inspectCheckout":
          return JSON.stringify(
            await inspectCheckout(checkout, command.query, {
              recordedBase: false,
              unresolvedBase: "origin/main",
            })
          );
        case "checkoutCommand":
          return JSON.stringify(
            command.operation.kind === "read"
              ? {
                  content: await readFile(
                    path.join(checkout, REPO_TOOL_MANIFEST_PATH),
                    "utf8"
                  ),
                  state,
                }
              : { exitCode: 0, stdout: "fixture", stderr: "" }
          );
        case "sessionCheckout":
          return JSON.stringify(
            command.operation.kind === "context"
              ? await supervisor.gitContext(
                  command.agentId,
                  command.workspace,
                  command.operation
                )
              : await supervisor.sessionCheckout(
                  command.agentId,
                  command.workspace,
                  command.operation
                )
          );
        case "sessionFile":
          return supervisor.sessionFile(
            command.agentId,
            command.workspace,
            command.operation,
            async (kind, dir, name) => {
              if (kind !== "collect")
                throw new Error("Unexpected file delivery");
              return (
                await readFile(dir ? path.join(dir, name) : name)
              ).toString("base64");
            }
          );
      }
      unexpected.push(command.kind);
      throw new Error(`Unexpected runner command: ${command.kind}`);
    },
  },
});

type Tool = { name: string; inputSchema: Record<string, unknown> };
type Reply = {
  error?: { code: number; message: string };
  result?: {
    tools?: Tool[];
    nextCursor?: string;
    isError?: boolean;
    content?: { text?: string }[];
    structuredContent?: {
      id?: string;
      agentId?: string;
      owners?: { persona: string }[];
      launched?: { agentId: string }[];
      failures?: { error: string }[];
    };
  };
};
type Outcome = "accepted" | `rpc:${number}` | `tool:${string}`;
type Difference = { local: unknown; runner: unknown };
type Args = Record<string, unknown>;

function git(...args: string[]) {
  return execFileSync("git", ["-C", checkout, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  }).trim();
}

it("keeps the MCP caller surface and call outcomes at the recorded parity boundary", async () => {
  const runnerId = ctx.runner!.id;
  const runnerCwd = `runner://${runnerId}/@session`;
  const token = await ctx.auth.getOrCreateAuthToken(ctx.pool);
  const cookie = await ctx.sessionCookie();
  const differences: Record<string, Difference> = {};
  const launched = new Set<string>();
  let callCount = 0;

  await mkdir(path.join(checkout, ".agents/personas"), { recursive: true });
  await writeFile(path.join(runnerState, "bindings", runnerKey), "\0managed");
  await writeFile(
    path.join(runnerState, "bindings", `${runnerKey}.repository`),
    "{}"
  );
  await mkdir(path.join(checkout, ".dispatch"));
  await mkdir(outside);
  await writeFile(
    path.join(checkout, REPO_TOOL_MANIFEST_PATH),
    JSON.stringify({
      tools: [
        {
          name: "fixture",
          description: "Print the fixture marker.",
          command: ["printf", "fixture"],
        },
      ],
    })
  );
  await writeFile(
    path.join(checkout, ".agents/personas/fixture.md"),
    "---\ntype: review\nname: Fixture reviewer\ndescription: Review fixture changes\n---\nInspect the fixture.\n"
  );
  await writeFile(
    path.join(checkout, ".agents/owners.json"),
    JSON.stringify({
      version: 1,
      rules: [{ paths: ["inside.txt"], personas: ["fixture"] }],
    })
  );
  await writeFile(path.join(checkout, "inside.txt"), "fixture\n");
  await writeFile(path.join(outside, "outside.txt"), "outside\n");
  git("init", "-b", "main");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Fixture baseline"
  );
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  await writeFile(path.join(checkout, "inside.txt"), "modified fixture\n");

  const {
    rows: [{ id: projectId }],
  } = await ctx.pool.query<{ id: string }>(
    "INSERT INTO projects (id, name, repo_root, color, repository) VALUES (gen_random_uuid(), 'Parity', $1, '#336699', 'https://github.com/fixture/example.git') RETURNING id",
    [checkout]
  );
  for (const [index, id] of callers.entries()) {
    await ctx.pool.query(
      `INSERT INTO agents (id, name, type, status, cwd, files_dir, runner_id, project_id, runner_managed, base_branch)
       VALUES ($1, $1, 'codex', 'running', $2, $3, $4, $5, $6, 'main')`,
      [
        id,
        index ? runnerCwd : checkout,
        path.join(root, id),
        index ? runnerId : "local",
        projectId,
        Boolean(index),
      ]
    );
  }

  async function request(
    id: string,
    method: string,
    params: Args,
    auth: "agent" | "session" = "agent"
  ): Promise<Reply> {
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/mcp/${id}`,
      headers: {
        ...(auth === "session"
          ? { cookie }
          : {
              authorization: `Bearer ${ctx.auth.createAgentMcpToken(token, id)}`,
            }),
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: { jsonrpc: "2.0", id: 1, method, params },
    });
    expect(response.statusCode, `${id} ${method} ${params.name ?? ""}`).toBe(
      200
    );
    return JSON.parse(
      response.body.match(/^data: (.*)$/m)?.[1] ?? response.body
    );
  }

  function compare(key: string, local: unknown, runner: unknown) {
    if (!isDeepStrictEqual(local, runner)) differences[key] = { local, runner };
  }

  const surfaces = await Promise.all(
    callers.map(async (id, index) => {
      const reply = await request(id, "tools/list", {});
      expect(reply.error).toBeUndefined();
      expect(reply.result?.nextCursor).toBeUndefined();
      expect(reply.result?.tools?.length).toBeGreaterThan(0);
      const entries = reply.result!.tools!.map(
        ({ name, inputSchema }) =>
          [
            name,
            // The CRUD schemas interpolate the caller's default cwd in one help string.
            JSON.parse(
              JSON.stringify(inputSchema).replaceAll(
                `Working directory. Defaults to ${index ? runnerCwd : checkout}.`,
                "Working directory. Defaults to <caller cwd>."
              )
            ),
          ] as const
      );
      const surface = new Map(entries);
      expect(surface.size).toBe(entries.length);
      return surface;
    })
  );
  const [local, runner] = surfaces as [
    Map<string, unknown>,
    Map<string, unknown>,
  ];
  const toolNames = new Set([...local.keys(), ...runner.keys()]);
  for (const name of toolNames) {
    compare(
      `surface/${name}`,
      local.get(name) ?? "absent",
      runner.get(name) ?? "absent"
    );
  }

  function outcome(reply: Reply): Outcome {
    // MCP erases the thrown exception class. Use the protocol code where present
    // and the refusal text (minus fixture paths and registration ID) otherwise.
    if (reply.error) return `rpc:${reply.error.code}`;
    expect(reply.result).toBeDefined();
    // Owner review dispatch returns failed launches inside a successful RPC.
    const failures = reply.result!.structuredContent?.failures;
    if (!reply.result!.isError && !failures?.length) return "accepted";
    const message =
      failures?.map(({ error }) => error).join("\n") ??
      reply.result!.content?.[0]?.text;
    expect(message).toBeTruthy();
    return `tool:${message!.replaceAll(root, "<fixture>").replaceAll(runnerId, "<runner>")}`;
  }

  async function call(
    label: string,
    name: string,
    args: Args | [Args, Args],
    positive = false,
    auth: "agent" | "session" = "agent"
  ) {
    const replies = await Promise.all(
      callers.map((id, index) =>
        request(
          id,
          "tools/call",
          { name, arguments: Array.isArray(args) ? args[index] : args },
          auth
        )
      )
    );
    const [a, b] = replies.map(outcome);
    compare(`call/${label}`, a, b);
    if (positive) expect(a, label).toBe("accepted");
    for (const { result } of replies) {
      const payload = result?.structuredContent;
      if (payload?.agentId) launched.add(payload.agentId);
      for (const agent of payload?.launched ?? []) launched.add(agent.agentId);
    }
    callCount++;
    return replies;
  }

  await call("list_personas", "list_personas", { type: "review" }, true);
  await call("persona_templates", "persona_templates", {}, true);
  await call("persona_validate", "persona_validate", {}, true);
  await call(
    "persona_upsert",
    "persona_upsert",
    {
      slug: "parity",
      name: "Parity",
      description: "Fixture",
      instructions: "Inspect the fixture.",
    },
    true
  );
  const previews = await call(
    "owner_reviews/preview",
    "launch_owner_reviews",
    { context: "Inspect the fixture.", dryRun: true },
    true
  );
  for (const preview of previews)
    expect(preview.result?.structuredContent?.owners).toMatchObject([
      { persona: "fixture" },
    ]);
  await call(
    "owner_reviews/launch",
    "launch_owner_reviews",
    { context: "Inspect the fixture." },
    true
  );
  await call("repo_fixture", "repo_fixture", {}, true);
  await call(
    "repo_fixture/session-cookie",
    "repo_fixture",
    {},
    true,
    "session"
  );
  const lists = await call("list_agents", "list_agents", {}, true);
  // One repository identity (D5, D8): the local caller keys by its root, the
  // runner caller by its project's primary root, and each lists the other.
  for (const [index, list] of lists.entries()) {
    const agents = (
      list.result?.structuredContent as { agents?: { id: string }[] }
    ).agents;
    expect(agents?.map(({ id }) => id)).toContain(callers[1 - index]);
  }
  await call(
    "brain_store_object/project",
    "brain_store_object",
    callers.map((id) => ({
      collection: "parity",
      name: id,
      value: { caller: id },
    })) as [Args, Args],
    true
  );
  const brains = await call(
    "brain_list_objects/project",
    "brain_list_objects",
    { collection: "parity" },
    true
  );
  // Both callers read and write one Brain.
  for (const brain of brains)
    for (const id of callers)
      expect(JSON.stringify(brain.result?.structuredContent)).toContain(id);
  await call("task_list", "task_list", {}, true);
  await call("usage_watch_list", "usage_watch_list", {}, true);
  await call(
    "usage_unwatch",
    "usage_unwatch",
    { id: "00000000-0000-0000-0000-000000000000" },
    true
  );

  const launch = {
    name: "Parity launch",
    prompt: "Inspect the fixture.",
    type: "codex",
  };
  await call("launch_agent/child", "launch_agent", launch, true);
  await call(
    "launch_agent/independent",
    "launch_agent",
    { ...launch, child: false },
    true
  );
  await call(
    "launch_agent/child-worktree",
    "launch_agent",
    {
      ...launch,
      useWorktree: true,
      createNewBranch: true,
      worktreeBranch: "parity-child",
    },
    true
  );
  await call(
    "launch_agent/independent-worktree",
    "launch_agent",
    {
      ...launch,
      child: false,
      useWorktree: true,
      createNewBranch: true,
      worktreeBranch: "parity-independent",
    },
    true
  );
  await call(
    "launch_agent/explicit-path",
    "launch_agent",
    { ...launch, cwd: checkout },
    true
  );
  // Another folder on the runner caller's machine needs a move after start.
  await call(
    "launch_agent/other-folder",
    "launch_agent",
    { ...launch, cwd: outside },
    true
  );
  await call(
    "launch_agent/persona",
    "launch_agent",
    { ...launch, persona: "fixture" },
    true
  );

  for (const [target, location] of [
    ["path", { directory: checkout }],
    ["project", { projectId }],
    ["default", {}],
  ] as const) {
    for (const kind of ["template", "job"] as const) {
      const names = [`${kind}-${target}-local`, `${kind}-${target}-runner`];
      const createArgs = (name: string) => ({
        name,
        prompt: "Inspect the fixture.",
        ...location,
      });
      await call(
        `create_${kind}/${target}`,
        `create_${kind}`,
        [createArgs(names[0]!), createArgs(names[1]!)],
        true
      );
      const { rows } = await ctx.pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM ${kind === "job" ? "jobs" : "templates"} WHERE name = ANY($1)`,
        [names]
      );
      expect(rows).toHaveLength(2);
      const id = (index: number) =>
        rows.find((row) => row.name === names[index])!.id;
      const updateArgs = (index: number) => ({
        [`${kind}Id`]: id(index),
        description: "Updated fixture",
        ...location,
      });
      await call(
        `update_${kind}/${target}`,
        `update_${kind}`,
        [updateArgs(0), updateArgs(1)],
        true
      );
      if (kind === "job") {
        await call(
          `run_job/${target}`,
          "run_job",
          [{ jobId: id(0) }, { jobId: id(1) }],
          true
        );
      } else {
        if (target === "project")
          // The runner caller's project template: for the local caller, a
          // project on another runner (D7).
          await call(
            "run_template/project-on-runner",
            "launch_agent",
            [
              { ...launch, templateId: id(1) },
              { ...launch, templateId: id(1) },
            ],
            true
          );
        await call(
          `run_template/${target}`,
          "launch_agent",
          [
            { ...launch, templateId: id(0) },
            { ...launch, templateId: id(1) },
          ],
          true
        );
      }
    }
  }

  await call(
    "pr_risk",
    "get_pull_request_risk",
    callers.map((agentId) => ({
      agentId,
      url: "https://github.com/fixture/example/pull/1",
    })) as [Args, Args]
  );
  // Both callers get the same trigger location schema and accepted inputs.
  const triggerTemplates = await ctx.pool.query<{ id: string }>(
    "SELECT id FROM templates WHERE project_id = $1 LIMIT 1",
    [projectId]
  );
  const triggerTemplateId = triggerTemplates.rows[0]!.id;
  for (const [label, location] of [
    ["offline", { runner: "offline-trigger-fixture" }],
    ["controller", { runner: "local" }],
    ["defaults", {}],
  ] as const) {
    await call(
      `task_column_update/${label}`,
      "task_column_update",
      {
        projectId,
        column: "ready",
        trigger: { templateId: triggerTemplateId, ...location },
      },
      true
    );
  }

  await ctx.pool.query(
    "UPDATE agents SET project_id = NULL WHERE id = ANY($1)",
    [callers]
  );
  await call("task_list/no-project", "task_list", {});
  await call("brain_list_objects/no-project", "brain_list_objects", {
    collection: "parity",
  });
  await call("create_template/no-project", "create_template", [
    { name: "projectless-local", prompt: launch.prompt },
    { name: "projectless-runner", prompt: launch.prompt },
  ]);
  await call(
    "create_job/no-project",
    "create_job",
    [
      { name: "projectless-job-local", prompt: launch.prompt },
      { name: "projectless-job-runner", prompt: launch.prompt },
    ],
    true
  );
  await call("set_workspace/reset", "set_workspace", {}, true);
  await call("set_workspace/inside", "set_workspace", { path: checkout }, true);
  function attachment(dir: string, file: string) {
    return [{ type: "file", path: path.join(dir, file) }];
  }
  const acceptedPosts = await call(
    "post/attach-inside",
    "post",
    {
      attachments: attachment(checkout, "inside.txt"),
    },
    true
  );
  await call(
    "post/attach-outside",
    "post",
    {
      attachments: attachment(outside, "outside.txt"),
    },
    true
  );
  const updateArgs = (index: number, dir: string, file: string) => {
    const id = acceptedPosts[index]?.result?.structuredContent?.id;
    expect(id).toBeTruthy();
    return { id, attachments: attachment(dir, file) };
  };
  await call(
    "update/attach-inside",
    "update",
    [
      updateArgs(0, checkout, "inside.txt"),
      updateArgs(1, checkout, "inside.txt"),
    ],
    true
  );
  await call(
    "update/attach-outside",
    "update",
    [
      updateArgs(0, outside, "outside.txt"),
      updateArgs(1, outside, "outside.txt"),
    ],
    true
  );
  await call("set_workspace/outside", "set_workspace", { path: outside }, true);
  await expect
    .poll(
      async () => {
        const { rows } = await ctx.pool.query(
          "SELECT id FROM agents WHERE id = ANY($1) AND status = 'creating'",
          [[...launched]]
        );
        return rows;
      },
      { timeout: 3_000 }
    )
    .toEqual([]);
  expect(unexpected).toEqual([]);

  const expected = Object.fromEntries(
    Object.entries(baseline).map(([key, entry]) => [
      key,
      { local: entry.local, runner: entry.runner },
    ])
  );
  // Exact equality rejects new or changed differences and stale baseline entries.
  expect(
    differences,
    `${toolNames.size} tools and ${callCount} call pairs`
  ).toEqual(expected);
});
