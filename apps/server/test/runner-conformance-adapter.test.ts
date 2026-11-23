/*
 * Conformance on the temporary in-app local adapter (`runners/local.ts`),
 * for the operations it routes today. The adapter is a known divergence
 * until the local child serves its family; its red entries are in
 * packages/runner-conformance/baseline.json under the `adapter` lane.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { afterAll, expect, it, vi } from "vitest";
import {
  sessionFromWire,
  type CallName,
  type Req,
  type Res,
} from "@dispatch/runner-protocol/contract";
import {
  compareBaseline,
  readBaseline,
  runLane,
  scenarios,
} from "@dispatch/runner-conformance";
import { createLocalRunner } from "../src/agents/local-runner.js";
import { checkoutRunners } from "../src/runners/directory.js";

const logger = { info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger;
const root = mkdtempSync(path.join(os.tmpdir(), "runner-conformance-adapter-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The operations the adapter routes; everything else is the child's. */
const ROUTED = new Set(["runner.describe", "checkout.exec"]);

it("matches the adapter lane's baseline", async () => {
  const checkout = path.join(root, "checkout");
  mkdirSync(checkout);
  const agent = {
    id: "conformance-session",
    cwd: checkout,
    worktreePath: null,
    workspacePath: null,
  };
  const { directory, placement } = checkoutRunners(
    { local: createLocalRunner(path.join(root, "hosts"), logger) },
    agent
  );
  const adapter = directory.for(placement);
  const results = await runLane(
    async () => ({
      runner: {
        ...adapter,
        // Dispatch reads the guard through the adapter's manifest read today.
        async call<K extends CallName>(op: K, req: Req<K>, opts?: object) {
          if (op !== "checkout.read") return adapter.call(op, req, opts);
          const { path: file } = req as Req<"checkout.read">;
          const read = await adapter.readManifest({
            checkout: "effective",
            path: file,
            kind: "read",
          });
          return (read && { data: read.content, digest: read.state }) as Res<K>;
        },
      },
      session: sessionFromWire(agent.id),
      async seed(file, content) {
        mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
        writeFileSync(path.join(checkout, file), content);
      },
      async close() {},
    }),
    scenarios.filter((scenario) => ROUTED.has(scenario.op))
  );
  expect(compareBaseline("adapter", results, readBaseline())).toEqual([]);
});
