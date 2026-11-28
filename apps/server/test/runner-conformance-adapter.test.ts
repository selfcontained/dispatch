/*
 * Conformance on the temporary in-app local adapter (`runners/local.ts`),
 * for the operations it routes today: here its in-process workload, the
 * path a session the child holds no binding for takes (T18). Any red entry
 * goes in packages/runner-conformance/baseline.json under the `adapter` lane.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { afterAll, expect, it, vi } from "vitest";
import { sessionFromWire } from "@dispatch/runner-protocol/contract";
import {
  compareBaseline,
  readBaseline,
  runLane,
  scenarios,
} from "@dispatch/runner-conformance";
import { checkoutRunners } from "../src/runners/directory.js";
import { controllerPlacement } from "../src/runners/placement.js";

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
    placement: controllerPlacement,
  };
  const { directory, placement } = checkoutRunners({}, agent);
  const adapter = directory.for(placement);
  const results = await runLane(
    async () => ({
      runner: adapter,
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
