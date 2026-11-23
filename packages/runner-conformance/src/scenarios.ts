/*
 * One scenario set for every implementation of the contract. A scenario talks
 * to a `Runner` only; the lane supplies the runner and a session whose
 * checkout it can seed. Every operation has at least one scenario. An
 * operation whose scenarios have not been written yet has a `pending`
 * scenario that fails, so it is a named red baseline entry, never a skip.
 */
import {
  RunnerCallError,
  operationNames,
  type ErrorCode,
  type OpName,
  type Req,
  type Runner,
  type SessionHandle,
} from "@dispatch/runner-protocol/contract";
import { OPERATION_TASK, SCENARIO_TASK } from "./tasks.js";

export type LaneFixture = {
  /** Already wrapped with `checked`. */
  runner: Runner;
  /** A session whose current checkout `seed` writes into. */
  session: SessionHandle;
  /** Writes a file at a relative path in the session's checkout. */
  seed(path: string, content: string): Promise<void>;
};

export type Scenario = {
  /** `<operation>/<case>` */
  id: string;
  op: OpName;
  run(fixture: LaneFixture): Promise<void>;
};

export class ScenarioFailure extends Error {
  override name = "ScenarioFailure";
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ScenarioFailure(message);
}

async function rejectsWith(
  promise: Promise<unknown>,
  code: ErrorCode
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RunnerCallError) {
      expect(
        error.code === code,
        `Expected ${code}, got ${error.code}: ${error.message}`
      );
      return;
    }
    throw error;
  }
  throw new ScenarioFailure(`Expected ${code}, but the call succeeded.`);
}

const GUARD = "conformance/guard.txt";

/** Seeds the guard file and reads it back for the digest a guarded command needs. */
async function guarded(
  fixture: LaneFixture,
  argv: string[],
  content = "guard\n"
): Promise<Req<"checkout.exec">> {
  await fixture.seed(GUARD, content);
  const target = { session: fixture.session, checkout: "current" } as const;
  const file = await fixture.runner.call("checkout.read", {
    target,
    path: GUARD,
    encoding: "utf8",
    maxBytes: null,
  });
  expect(file?.data === content, "checkout.read returned other content.");
  expect(file.digest, "checkout.read returned no digest to guard with.");
  return {
    target,
    guard: { path: GUARD, digest: file.digest },
    argv,
    env: {},
    timeoutMs: null,
    maxOutput: null,
    shell: "direct",
  };
}

const written: Scenario[] = [
  {
    id: "runner.describe/success",
    op: "runner.describe",
    async run({ runner }) {
      const described = await runner.call("runner.describe", {});
      const offline = runner.describe();
      expect(
        JSON.stringify(described.runnerId) === JSON.stringify(offline.runnerId),
        "runner.describe and describe() name different runners."
      );
    },
  },
  {
    id: "checkout.exec/success",
    op: "checkout.exec",
    async run(fixture) {
      const req = await guarded(fixture, [
        "sh",
        "-c",
        "printf out; printf err >&2; exit 3",
      ]);
      const result = await fixture.runner.call("checkout.exec", req);
      expect(result.exitCode === 3, `exitCode ${result.exitCode}, want 3`);
      expect(
        result.stdout === "out",
        `stdout ${JSON.stringify(result.stdout)}`
      );
      expect(
        result.stderr === "err",
        `stderr ${JSON.stringify(result.stderr)}`
      );
    },
  },
  {
    id: "checkout.exec/stale",
    op: "checkout.exec",
    async run(fixture) {
      const req = await guarded(fixture, ["true"]);
      await fixture.seed(GUARD, "changed\n");
      await rejectsWith(fixture.runner.call("checkout.exec", req), "stale");
    },
  },
  {
    id: "checkout.exec/cancelled",
    op: "checkout.exec",
    async run(fixture) {
      const req = await guarded(fixture, ["sh", "-c", "sleep 10"]);
      const controller = new AbortController();
      const call = fixture.runner.call("checkout.exec", req, {
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 300);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const hung = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new ScenarioFailure("Not cancelled within 2 s of abort.")),
          2_300
        );
      });
      // A runner that ignores the signal must not hold the suite for the command's length.
      call.catch(() => {});
      await rejectsWith(Promise.race([call, hung]), "cancelled").finally(() =>
        clearTimeout(timer)
      );
    },
  },
];

function pending(op: OpName): Scenario {
  const task = SCENARIO_TASK[op] ?? OPERATION_TASK[op];
  return {
    id: `${op}/pending`,
    op,
    async run() {
      throw new ScenarioFailure(`No scenario yet; ${task} writes it.`);
    },
  };
}

/** Written scenarios, then one pending scenario for each operation without any. */
export const scenarios: readonly Scenario[] = [
  ...written,
  ...operationNames
    .filter((op) => !written.some((scenario) => scenario.op === op))
    .map(pending),
];
