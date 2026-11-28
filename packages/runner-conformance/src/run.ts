import { readFileSync } from "node:fs";
import { checked } from "./checked.js";
import { scenarios, type LaneFixture, type Scenario } from "./scenarios.js";

export type LaneName = "local" | "remote" | "adapter";

/** A started lane. `close` releases everything the lane created. */
export type Lane = LaneFixture & { close(): Promise<void> };

/** The lane cannot start at all; every scenario fails with this reason. */
export class LaneUnavailable extends Error {
  override name = "LaneUnavailable";
}

export type Result = { id: string; ok: boolean; error?: string; ms: number };

/** A red entry: a scenario that fails on a lane today, and the task that turns it green. */
export type BaselineEntry = {
  lane: LaneName;
  scenario: string;
  task: string;
  reason: string;
};

const SCENARIO_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Scenario timed out after ${ms} ms.`)),
        ms
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Runs every selected scenario on one lane. Scenarios run in order on one runner. */
export async function runLane(
  start: () => Promise<Lane>,
  selected: readonly Scenario[] = scenarios
): Promise<Result[]> {
  let lane: Lane;
  try {
    lane = await start();
  } catch (error) {
    if (!(error instanceof LaneUnavailable)) throw error;
    return selected.map(({ id }) => ({
      id,
      ok: false,
      error: error.message,
      ms: 0,
    }));
  }
  const fixture: LaneFixture = { ...lane, runner: checked(lane.runner) };
  const results: Result[] = [];
  try {
    for (const scenario of selected) {
      const started = performance.now();
      try {
        await withTimeout(scenario.run(fixture), SCENARIO_TIMEOUT_MS);
        results.push({ id: scenario.id, ok: true, ms: elapsed(started) });
      } catch (error) {
        results.push({
          id: scenario.id,
          ok: false,
          error: `${(error as Error).name}: ${(error as Error).message}`,
          ms: elapsed(started),
        });
      }
    }
  } finally {
    await lane.close();
  }
  return results;
}

const elapsed = (started: number) => Math.round(performance.now() - started);

/**
 * Green must pass and red must fail: an unbaselined failure, an unexpected
 * pass and an entry for a scenario that was not run are all errors.
 */
export function compareBaseline(
  lane: LaneName,
  results: readonly Result[],
  baseline: readonly BaselineEntry[]
): string[] {
  const red = new Map(
    baseline
      .filter((entry) => entry.lane === lane)
      .map((entry) => [entry.scenario, entry])
  );
  const errors: string[] = [];
  for (const result of results) {
    const entry = red.get(result.id);
    red.delete(result.id);
    if (result.ok && entry)
      errors.push(
        `${lane} ${result.id} passed unexpectedly; remove its baseline entry (${entry.task}).`
      );
    if (!result.ok && !entry)
      errors.push(`${lane} ${result.id} failed: ${result.error}`);
  }
  for (const entry of red.values())
    errors.push(
      `${lane} ${entry.scenario} has a baseline entry but was not run.`
    );
  return errors;
}

export function readBaseline(): BaselineEntry[] {
  return JSON.parse(
    readFileSync(new URL("../baseline.json", import.meta.url), "utf8")
  ) as BaselineEntry[];
}
