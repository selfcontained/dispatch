import Fastify from "fastify";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  beginArchive,
  executeArchive,
  deleteAgentDirect,
} from "../src/agents/archive.js";
import { registerAgentCrudRoutes } from "../src/routes/agents/crud-routes.js";
import { createMcpHandlers } from "../src/server/mcp-handlers.js";
import {
  archiveParityHarness,
  git,
  type Kind,
} from "./helpers/archive-parity.js";

// Independent oracle: main's documented model, not the implementation's predicate.
const decisions = [
  { state: "clean", mode: "auto", retained: false },
  { state: "clean", mode: "keep", retained: true },
  { state: "clean", mode: "force", retained: false },
  { state: "uncommitted", mode: "auto", retained: true },
  { state: "uncommitted", mode: "keep", retained: true },
  { state: "uncommitted", mode: "force", retained: false },
  { state: "unmerged", mode: "auto", retained: true },
  { state: "unmerged", mode: "keep", retained: true },
  { state: "unmerged", mode: "force", retained: false },
] as const;
const cases = (
  ["Local folder", "Local repository", "runner"] as Kind[]
).flatMap((kind) =>
  (["UI/API", "MCP", "cascade"] as const).flatMap((origin) =>
    decisions.map((decision) => ({ ...decision, kind, origin }))
  )
);
let harness: Awaited<ReturnType<typeof archiveParityHarness>>;
beforeAll(async () => {
  harness = await archiveParityHarness();
}, 30000);
afterAll(async () => {
  await harness?.close();
});

it.each(cases)(
  "$kind / $origin / $state / $mode",
  async ({ kind, origin, state, mode, retained }) => {
    const f = await harness.fixture(kind);
    try {
      if (state !== "clean")
        await writeFile(join(f.dir, "draft.txt"), "fixture change\n");
      if (state === "unmerged") {
        git(f.dir, "add", "draft.txt");
        git(
          f.dir,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.test",
          "commit",
          "-qm",
          "unlanded"
        );
      }
      const head = git(f.dir, "rev-parse", "HEAD");
      const observed = await f.runner.call("workspace.observe", {
        session: f.session,
      });
      expect(observed.checkout?.unmerged).toBe(state === "unmerged");
      expect(Boolean(observed.checkout?.uncommittedFiles.length)).toBe(
        state === "uncommitted"
      );
      expect(existsSync(f.host)).toBe(true);
      expect(existsSync(f.binding)).toBe(true);
      expect(existsSync(f.receipt)).toBe(true);

      if (origin === "UI/API") {
        // Real HTTP route. UI choice presentation is covered by the unchanged
        // real dialog tests; this exercises the API after a mode is selected.
        const app = Fastify();
        let work: Promise<void> | undefined;
        await registerAgentCrudRoutes(app, {
          agentManager: {
            beginArchive: (id: string, selected: typeof mode) =>
              beginArchive(f.deps, id, selected),
            executeArchive: (id: string, callbacks: typeof f.callbacks) =>
              executeArchive(f.deps, id, callbacks),
          },
          withStreamFlag: (agent: unknown) => agent,
          publishUiEvent: () => {},
          onArchivedAgentsDeleted: () => {},
          onArchiveError: (_id: string, error: unknown) => f.errors.push(error),
          trackArchivePromise: (_id: string, request: Promise<void>) => {
            work = request;
          },
          handleAgentError: (reply: any, error: Error) =>
            reply.code(500).send({ error: error.message }),
        } as never);
        try {
          const response = await app.inject({
            method: "DELETE",
            url: `/api/v1/agents/${f.id}${mode === "auto" ? "" : `?cleanupWorktree=${mode}`}`,
          });
          expect(response.statusCode, response.body).toBe(202);
          await work;
        } finally {
          await app.close();
        }
      } else if (origin === "MCP") {
        let selected: string | undefined;
        const handlers = createMcpHandlers({
          pool: f.deps.pool,
          agentManager: { getAgent: async () => f.agent },
          jobService: { getActiveRunForAgent: async () => null },
          beginBackgroundArchive: async (id: string, choice: typeof mode) => {
            selected = choice;
            return beginArchive(f.deps, id, choice);
          },
        } as never);
        // Omit auto to pin main's default. As in the lifecycle runtime, teardown
        // happens after the tool returns; no timer or operation result is faked.
        await handlers.archiveAgent(f.id, {
          agentId: f.id,
          ...(mode === "auto" ? {} : { cleanupWorktree: mode }),
        });
        expect(selected).toBe(mode);
        await executeArchive(f.deps, f.id, f.callbacks);
      } else {
        // A cascade is the parent's decision, never a child's Keep choice.
        expect(await deleteAgentDirect(f.deps, f.id)).toEqual([f.id]);
        expect(f.agent.archiveCleanupMode).toBe("force");
      }
      const kept = origin === "cascade" ? false : retained;
      expect(f.errors).toEqual([]);
      expect(f.deleted()).toBe(true);
      expect(f.pending()).toBe(false);
      expect(existsSync(f.dir), "checkout decision").toBe(kept);
      const ref = spawnSync("git", [
        `--git-dir=${f.common}`,
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${f.branch}`,
      ]);
      expect([0, 1], ref.stderr?.toString()).toContain(ref.status);
      expect(ref.status === 0, "Dispatch-created branch").toBe(kept);
      if (kept) expect(git(f.dir, "rev-parse", "HEAD")).toBe(head);
      expect(
        {
          host: existsSync(f.host),
          binding: existsSync(f.binding),
          sidecars: await f.leftovers(),
          receipt: existsSync(f.receipt),
        },
        "only the deliberately kept checkout may survive"
      ).toEqual({ host: false, binding: false, sidecars: [], receipt: false });
    } finally {
      await f.cleanup().catch(() => {});
    }
  }
);

it.each(["Local folder", "Local repository", "runner"] as Kind[])(
  "%s preserves a user branch when force removes its checkout",
  async (kind) => {
    const f = await harness.fixture(kind, true);
    try {
      expect(await deleteAgentDirect(f.deps, f.id)).toEqual([f.id]);
      expect(f.errors).toEqual([]);
      expect(f.pending()).toBe(false);
      expect(existsSync(f.dir)).toBe(false);
      expect(
        git(f.common, "show-ref", "--verify", `refs/heads/${f.branch}`)
      ).toContain(`refs/heads/${f.branch}`);
      expect({
        host: existsSync(f.host),
        binding: existsSync(f.binding),
        sidecars: await f.leftovers(),
        receipt: existsSync(f.receipt),
      }).toEqual({ host: false, binding: false, sidecars: [], receipt: false });
    } finally {
      await f.cleanup().catch(() => {});
    }
  }
);
