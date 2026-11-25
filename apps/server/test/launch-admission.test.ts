import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { admitLaunch } from "../src/agents/launch-admission.js";
import { AgentManager } from "../src/agents/manager.js";
import { resolvePath } from "../src/agents/workspace.js";
import { launchDirectory } from "../src/agents/workspace-launch.js";
import { checkoutReadPlacement } from "../src/runners/placement.js";

type Launch = Parameters<AgentManager["createAgent"]>[0];
type Options = NonNullable<Parameters<AgentManager["createAgent"]>[1]>;

const folder = "/repo";
const managed = "runner://test/@session";
const configured = "runner://test/workspace";
const ownerId = "owner";
const projectId = "project";
const templateId = "template";

const shared = "Invalid shared checkout binding.";
const childBinding = "Invalid child checkout binding.";

const callers: {
  caller: string;
  input: Partial<Launch>;
  options?: Options;
  expected: [
    folder: string | null,
    managed: string | null,
    configured: string | null,
    borrowed: string | null,
  ];
}[] = [
  {
    caller: "Create Agent/API",
    input: {},
    expected: [null, null, null, shared],
  },
  {
    caller: "MCP child",
    input: {
      parentAgentId: ownerId,
      launchedByAgentId: ownerId,
      useWorktree: false,
    },
    expected: [null, null, null, null],
  },
  {
    caller: "MCP independent",
    input: { launchedByAgentId: ownerId, useWorktree: false },
    // Borrows the launcher's checkout, as it runs in the launcher's folder locally.
    expected: [null, null, null, null],
  },
  {
    caller: "task with template",
    input: { templateId, projectId },
    expected: [null, null, null, shared],
  },
  {
    caller: "job",
    input: { jobRunId: "run" },
    expected: [null, null, null, shared],
  },
  {
    caller: "template",
    input: { templateId },
    expected: [null, null, null, shared],
  },
  {
    caller: "persona review",
    input: {
      role: "review",
      persona: "code-review",
      parentAgentId: ownerId,
      launchedByAgentId: ownerId,
      useWorktree: false,
    },
    expected: [null, null, null, null],
  },
];

async function checkAdmission(
  input: Launch,
  options: Options = {},
  flags: {
    available?: boolean;
    sessionFiles?: boolean;
    sharedWorktree?: boolean;
    ownerCwd?: string;
  } = {}
): Promise<string | null> {
  // Stop at the first launch/lookup step after admission. No session or DB
  // is needed, and a different exception still fails the corresponding row.
  const admitted = new Error("admitted");
  const stop = vi.fn(() => {
    throw admitted;
  });
  const owner = {
    id: ownerId,
    cwd: flags.ownerCwd ?? input.cwd,
    placement: checkoutReadPlacement(flags.ownerCwd ?? input.cwd),
    projectId: null,
    fullAccess: false,
  };
  const manager = Object.assign(Object.create(AgentManager.prototype), {
    getAgent: vi.fn(async (id) => (id === owner.id ? owner : null)),
    remote: {
      available: () => flags.available ?? true,
      isManagedWorkspace: () =>
        input.cwd === managed && (flags.available ?? true),
      supportsSessionFiles: () => flags.sessionFiles ?? true,
      supportsSharedWorktree: () => flags.sharedWorktree ?? true,
    },
    config: { agentRuntime: "acp" },
    pool: {
      query: vi.fn(async (sql: string) => ({
        rows: sql.includes("FROM templates")
          ? [{ project_id: null }]
          : sql.includes("WHERE id=$1")
            ? [{ repo_root: folder, repository: "https://example.test/repo" }]
            : [],
      })),
    },
    // The launch folder is resolved through the agent's runner (path.resolve).
    launchDirectory: stop,
    resolveLaunchPath: stop,
    prepareCreate: stop,
  }) as AgentManager;
  try {
    await AgentManager.prototype.createAgent.call(manager, input, options);
  } catch (error) {
    if (error === admitted) return null;
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("Launch test must stop before creating an agent");
}

describe("launch admission compatibility", () => {
  const targets = [
    { target: "local folder", cwd: folder, borrowed: false },
    { target: "managed runner", cwd: managed, borrowed: false },
    { target: "configured runner", cwd: configured, borrowed: false },
    { target: "borrowed runner checkout", cwd: managed, borrowed: true },
  ];
  it.each(
    callers.flatMap(({ expected, ...row }) =>
      targets.map((target, i) => ({ ...row, ...target, expected: expected[i] }))
    )
  )(
    "$caller → $target",
    async ({ cwd, input, options, borrowed, expected }) => {
      expect(
        await checkAdmission(
          { cwd, ...input },
          borrowed ? { useWorktreeOf: ownerId } : cwd === folder ? {} : options
        )
      ).toBe(expected);
    }
  );

  // N4 (T36): a local owner's checkout binds as a runner owner's does.
  it.each([
    { parentAgentId: ownerId, launchedByAgentId: ownerId },
    { launchedByAgentId: ownerId },
  ])("binds a local owner's checkout: %o", async (input) => {
    expect(
      await checkAdmission(
        { cwd: folder, ...input },
        { useWorktreeOf: ownerId }
      )
    ).toBeNull();
  });

  // T36: a template's saved runner is checked the same for every launcher.
  it.each([folder, managed])(
    "refuses an offline or unknown template runner for a launcher at %s",
    async (ownerCwd) => {
      for (const cwd of [managed, "runner://unknown/@session"])
        expect(
          await checkAdmission(
            {
              cwd,
              templateId,
              repository: {},
              parentAgentId: ownerId,
              launchedByAgentId: ownerId,
            },
            {},
            { available: false, ownerCwd }
          )
        ).toBe("The enrolled runner workspace is unavailable.");
    }
  );

  it("admits a standalone task persona on a managed runner", async () => {
    const input = { cwd: managed, persona: "task-persona" };
    expect(await checkAdmission({ ...input, projectId })).toBeNull();
    expect(await checkAdmission(input)).toBeNull();
  });

  it.each([
    {
      cwd: configured,
      input: { repository: {} },
      expected:
        "Enter a repository URL or select a project with a repository origin.",
    },
    {
      cwd: managed,
      input: { initialFiles: [{}] as Launch["initialFiles"] },
      flags: { sessionFiles: false },
      expected: "Update the runner to launch with startup files.",
    },
    {
      cwd: managed,
      flags: { available: false },
      expected: "The enrolled runner workspace is unavailable.",
    },
    {
      cwd: managed,
      input: { parentAgentId: ownerId, launchedByAgentId: ownerId },
      options: { useWorktreeOf: ownerId },
      flags: { sharedWorktree: false },
      expected: "Update the runner to launch an agent in an existing checkout.",
    },
    {
      cwd: managed,
      input: { launchedByAgentId: ownerId },
      options: { useWorktreeOf: ownerId },
      flags: { sharedWorktree: false },
      expected: "Update the runner to launch an agent in an existing checkout.",
    },
    {
      cwd: managed,
      input: { launchedByAgentId: ownerId, fullAccess: true },
      options: { useWorktreeOf: ownerId },
      expected: childBinding,
    },
    {
      cwd: managed,
      input: {
        launchedByAgentId: ownerId,
        role: "review" as const,
        persona: "code-review",
      },
      options: { useWorktreeOf: ownerId },
      expected: shared,
    },
  ])(
    "preserves rejection $expected",
    async ({ cwd, input, options, flags, expected }) => {
      expect(await checkAdmission({ cwd, ...input }, options, flags)).toBe(
        expected
      );
    }
  );
});

/** origin/main's `validateWorkingDirectory`, verbatim but for the error type. */
async function mainWorkingDirectory(rawCwd: string): Promise<string> {
  const cwd = rawCwd.startsWith("~/")
    ? path.join(process.env.HOME ?? "/", rawCwd.slice(2))
    : rawCwd === "~"
      ? (process.env.HOME ?? "/")
      : rawCwd;
  if (!path.isAbsolute(cwd))
    throw new Error("Working directory must be an absolute path.");
  const directory = await stat(cwd).catch(() => null);
  if (!directory || !directory.isDirectory())
    throw new Error("Working directory does not exist or is not a directory.");
  return cwd;
}

const outcome = (run: () => Promise<string>) =>
  run().then(
    (cwd) => ({ cwd }),
    (error: Error) => ({ error: error.message })
  );

describe("launch_agent's folder, as main resolves it", () => {
  let root: string;
  let home: string;
  const folders = () => [
    "relative/app",
    "~",
    "~/app",
    `${root}/app`,
    `${root}/app/../app`,
    `${root}/link`,
    `${root}/missing`,
    `${root}/file`,
    `${root}/sealed`,
    `${root}/locked/inner`,
    "runner://another/@session",
  ];
  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "launch-")));
    home = path.join(root, "home");
    await mkdir(path.join(home, "app"), { recursive: true });
    await mkdir(path.join(root, "app"));
    await symlink(path.join(root, "app"), path.join(root, "link"));
    await writeFile(path.join(root, "file"), "");
    await mkdir(path.join(root, "sealed"), { mode: 0o000 });
    await mkdir(path.join(root, "locked", "inner"), { recursive: true });
    await chmod(path.join(root, "locked"), 0o000);
    vi.stubEnv("HOME", home);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await chmod(path.join(root, "locked"), 0o755);
    await chmod(path.join(root, "sealed"), 0o755);
    await rm(root, { recursive: true, force: true });
  });

  it("answers each folder with main's directory or main's error", async () => {
    for (const raw of folders()) {
      const expected = await outcome(() => mainWorkingDirectory(raw));
      expect(
        await outcome(async () => launchDirectory(await resolvePath(raw)).cwd),
        raw
      ).toEqual(expected);
    }
  });

  it("admits another folder from a local caller, as main passes it on", () => {
    for (const cwd of folders()) {
      const request = {
        caller: "mcpChild",
        sourceWorkdir: "/caller",
        cwd,
      } as const;
      const target = admitLaunch({ phase: "mcpTarget", ...request });
      const template = admitLaunch({ phase: "mcpTemplate", ...request });
      const relative = !(
        cwd === "~" ||
        cwd.startsWith("~/") ||
        cwd.startsWith("/")
      );
      expect(target, cwd).toEqual({ ok: true, cwd });
      expect(template, cwd).toEqual(
        relative
          ? expect.objectContaining({
              ok: false,
              message: "Working directory must be an absolute path.",
            })
          : { ok: true, cwd }
      );
    }
  });
});

describe("launch_agent's folder from a runner caller (D7)", () => {
  let root: string;
  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "runner-")));
    await mkdir(path.join(root, "home", "app"), { recursive: true });
    await mkdir(path.join(root, "app"));
    await symlink(path.join(root, "app"), path.join(root, "link"));
    await writeFile(path.join(root, "file"), "");
    await mkdir(path.join(root, "locked", "inner"), { recursive: true });
    await chmod(path.join(root, "locked"), 0o000);
    vi.stubEnv("HOME", path.join(root, "home"));
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await chmod(path.join(root, "locked"), 0o755);
    await rm(root, { recursive: true, force: true });
  });

  /**
   * Admission through the manager up to its preparation, for a launcher
   * on runner `test`. Every folder question goes to `resolveLaunchPath`,
   * answered as the runner's workload worker answers it.
   */
  async function launchFrom(
    launcherFolder: string,
    input: Partial<Launch> = {}
  ) {
    const asked: { runner: string; path: string }[] = [];
    const launcher = {
      id: ownerId,
      cwd: managed,
      placement: checkoutReadPlacement(managed),
      projectId: null,
      fullAccess: false,
    };
    const admitted = new Error("admitted");
    const manager = Object.assign(Object.create(AgentManager.prototype), {
      getAgent: vi.fn(async (id) => (id === ownerId ? launcher : null)),
      remote: {
        available: () => true,
        isManagedWorkspace: () => true,
        supportsPreparedLaunch: () => true,
        supportsSessionWorkspaceSource: () => true,
        supportsSessionFiles: () => true,
        supportsSharedWorktree: () => true,
      },
      config: { agentRuntime: "acp" },
      pool: { query: vi.fn(async () => ({ rows: [] })) },
      resolveLaunchPath: vi.fn(async (placement, raw, options) => {
        asked.push({ runner: JSON.stringify(placement), path: raw });
        return resolvePath(raw, options);
      }),
      prepareCreate: vi.fn(async (input, _options, target) => {
        throw Object.assign(admitted, { input, target });
      }),
    }) as AgentManager;
    try {
      await AgentManager.prototype.createAgent.call(manager, {
        cwd: launcherFolder,
        launcherFolder,
        launchedByAgentId: ownerId,
        parentAgentId: ownerId,
        ...input,
      });
    } catch (error) {
      if (error === admitted) {
        const { input: launched, target } = admitted as unknown as {
          input: Launch;
          target: { placement: unknown; launcherDirectory?: { cwd: string } };
        };
        return {
          asked,
          cwd: launched.cwd,
          placement: JSON.stringify(target.placement),
          folder: target.launcherDirectory?.cwd,
        };
      }
      return { asked, error: (error as Error).message };
    }
    throw new Error("Launch test must stop before creating an agent");
  }

  const runner = JSON.stringify(checkoutReadPlacement(managed));

  it("resolves the folder on the caller's runner and keeps its locator", async () => {
    for (const raw of [`${root}/app`, `${root}/app/../app`, `${root}/link`]) {
      const result = await launchFrom(raw);
      expect(result, raw).toEqual({
        asked: [{ runner, path: raw }],
        cwd: managed,
        placement: runner,
        folder: await mainWorkingDirectory(raw),
      });
    }
    // `~` is the runner account's HOME, resolved there.
    expect(await launchFrom("~/app")).toMatchObject({
      asked: [{ runner, path: "~/app" }],
      placement: runner,
      folder: path.join(root, "home", "app"),
    });
  });

  it("answers a bad folder with main's error, from the caller's runner", async () => {
    for (const raw of [
      "relative/app",
      `${root}/missing`,
      `${root}/file`,
      `${root}/locked/inner`,
      // Neither another runner's locator nor a bare path moves the launch.
      "runner://another/@session",
    ]) {
      const result = await launchFrom(raw);
      expect(result, raw).toEqual({
        asked: [{ runner, path: raw }],
        error: (await outcome(() => mainWorkingDirectory(raw))).error,
      });
    }
  });

  it("never places a named folder on the controller or another runner", async () => {
    for (const raw of ["/", "/etc", `${root}/app`, "runner://another/@x"]) {
      const result = await launchFrom(raw);
      for (const question of result.asked)
        expect(question.runner, raw).toBe(runner);
      if ("placement" in result) expect(result.placement).toBe(runner);
    }
  });

  it("admits an unreadable folder its account can reach, as main does", async () => {
    const sealed = `${root}/sealed`;
    await mkdir(sealed, { mode: 0o000 });
    try {
      expect(await launchFrom(sealed)).toMatchObject({
        placement: runner,
        folder: await mainWorkingDirectory(sealed),
      });
    } finally {
      await chmod(sealed, 0o755);
    }
  });
});
